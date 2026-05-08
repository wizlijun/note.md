//! PDF export via WKWebView's `printOperation(with:)` API.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, wait for navigation completion, and run an
//! `NSPrintOperation` configured for A4 paper with auto-pagination — that
//! routes through the same PDF engine the system print dialog uses, so
//! `@page` rules in the print stylesheet are honoured.
//!
//! `WKWebView.createPDFWithConfiguration:completionHandler:` (the more
//! obvious-looking API) does NOT paginate — it captures the entire scroll
//! region as one tall PDF page. That's why we use the print operation
//! instead.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintOperation, NSPrintingPaginationMode, NSPaperOrientation,
    };
    use objc2_foundation::{
        MainThreadMarker, NSError, NSObject, NSObjectProtocol, NSRect, NSString, NSURL,
    };
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration,
    };

    /// The keys + values for the NSPrintInfo dictionary, defined as
    /// `NSPrintJobDisposition` / `NSPrintSaveJob` / `NSPrintJobSavingURL`
    /// in AppKit. objc2-app-kit doesn't expose these as constants in the
    /// version we're pinned to, so we construct them from string literals.
    fn nspr_key(s: &str) -> Retained<NSString> {
        NSString::from_str(s)
    }

    /// Ivars held by the navigation delegate.
    pub(super) struct DelegateIvars {
        webview: RefCell<Option<Retained<WKWebView>>>,
        self_ref: RefCell<Option<Retained<NavDelegate>>>,
        sender: Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>,
        output_path: String,
    }

    impl DelegateIvars {
        fn take_sender(&self) -> Option<tokio::sync::oneshot::Sender<Result<(), String>>> {
            self.sender.lock().ok().and_then(|mut g| g.take())
        }

        fn take_webview(&self) -> Option<Retained<WKWebView>> {
            self.webview.borrow_mut().take()
        }

        fn take_self_ref(&self) -> Option<Retained<NavDelegate>> {
            self.self_ref.borrow_mut().take()
        }
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = DelegateIvars]
        #[name = "MdEditorPdfNavDelegate"]
        pub(super) struct NavDelegate;

        unsafe impl NSObjectProtocol for NavDelegate {}

        unsafe impl WKNavigationDelegate for NavDelegate {
            #[unsafe(method(webView:didFinishNavigation:))]
            fn did_finish(&self, _webview: &WKWebView, _nav: Option<&WKNavigation>) {
                let result = self.run_print_to_pdf();
                self.dispatch_result(result);
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail(
                &self,
                _webview: &WKWebView,
                _nav: Option<&WKNavigation>,
                error: &NSError,
            ) {
                let msg = error.localizedDescription().to_string();
                self.dispatch_result(Err(format!("WKWebView navigation failed: {msg}")));
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional(
                &self,
                _webview: &WKWebView,
                _nav: Option<&WKNavigation>,
                error: &NSError,
            ) {
                let msg = error.localizedDescription().to_string();
                self.dispatch_result(Err(format!(
                    "WKWebView provisional navigation failed: {msg}"
                )));
            }
        }
    );

    impl NavDelegate {
        fn new(
            mtm: MainThreadMarker,
            webview: Retained<WKWebView>,
            output_path: String,
            sender: tokio::sync::oneshot::Sender<Result<(), String>>,
        ) -> Retained<Self> {
            let ivars = DelegateIvars {
                webview: RefCell::new(Some(webview)),
                self_ref: RefCell::new(None),
                sender: Mutex::new(Some(sender)),
                output_path,
            };
            let this = Self::alloc(mtm).set_ivars(ivars);
            let retained: Retained<Self> = unsafe { msg_send![super(this), init] };
            // Self-retain so the delegate stays alive across the navigation
            // and the print operation. Cleared in dispatch_result.
            *retained.ivars().self_ref.borrow_mut() = Some(retained.clone());
            retained
        }

        /// Send the result back to the awaiting future and tear down.
        fn dispatch_result(&self, result: Result<(), String>) {
            if let Some(sender) = self.ivars().take_sender() {
                let _ = sender.send(result);
            }
            let _ = self.ivars().take_webview();
            let _ = self.ivars().take_self_ref();
        }

        /// Configure NSPrintInfo for A4 + zero margins (CSS @page controls
        /// the visible margins) + save-to-file disposition, run the print
        /// operation synchronously, and return Ok(()) if the PDF was
        /// written.
        fn run_print_to_pdf(&self) -> Result<(), String> {
            let mtm = self.mtm();

            let webview = match self.ivars().webview.borrow().as_ref() {
                Some(w) => w.clone(),
                None => return Err("WKWebView dropped before print".into()),
            };
            let output_path = self.ivars().output_path.clone();

            unsafe {
                let _ = mtm;
                let print_info: Retained<NSPrintInfo> = NSPrintInfo::new();

                // A4 paper size in PostScript points (1pt = 1/72 inch).
                // 595.276 x 841.890; round to whole pts (NSPrintInfo accepts
                // fractional but whole numbers reduce flakiness).
                print_info.setPaperSize(objc2_foundation::NSSize {
                    width: 595.0,
                    height: 842.0,
                });
                print_info.setOrientation(NSPaperOrientation::Portrait);

                // Zero margins — let CSS @page rules in pdf.css control
                // the visible margin area.
                print_info.setTopMargin(0.0);
                print_info.setBottomMargin(0.0);
                print_info.setLeftMargin(0.0);
                print_info.setRightMargin(0.0);

                print_info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setHorizontallyCentered(false);
                print_info.setVerticallyCentered(false);

                // Set save-to-file disposition + URL via the print info dict.
                // (The print info dict is a mutable NSMutableDictionary.)
                let url = NSURL::fileURLWithPath(&NSString::from_str(&output_path));
                let dict = print_info.dictionary();

                let key_disposition = nspr_key("NSPrintJobDisposition");
                let value_save = nspr_key("NSPrintSaveJob");
                let key_url = nspr_key("NSPrintJobSavingURL");

                // setObject:forKey: on the mutable dict
                let _: () = msg_send![&*dict, setObject: &*value_save, forKey: &*key_disposition];
                let _: () = msg_send![&*dict, setObject: &*url, forKey: &*key_url];

                // Build the operation and run it synchronously, suppressing
                // both the print panel and progress sheet.
                let op: Retained<NSPrintOperation> =
                    webview.printOperationWithPrintInfo(&print_info);
                op.setShowsPrintPanel(false);
                op.setShowsProgressPanel(false);

                if !op.runOperation() {
                    return Err("NSPrintOperation reported failure".into());
                }
            }

            // Defence-in-depth: confirm the file actually appeared on disk.
            if !Path::new(&output_path).exists() {
                return Err(format!(
                    "print operation returned success but no file at {output_path}"
                ));
            }

            Ok(())
        }
    }

    pub async fn export_pdf(
        app: tauri::AppHandle,
        html: String,
        output_path: String,
        base_url: String,
    ) -> Result<String, String> {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

        // Wrap the sender so we can move it into the `FnOnce + Send`
        // closure dispatched to the main thread.
        let sender_holder = Mutex::new(Some(done_tx));
        let output_path_for_main = output_path.clone();

        app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new()
                .expect("run_on_main_thread closure must run on main thread");

            let sender = match sender_holder.lock().ok().and_then(|mut g| g.take()) {
                Some(s) => s,
                None => return,
            };

            // The webview frame is incidental — pagination is driven by
            // NSPrintInfo's paper size. A4-ish initial frame keeps layout
            // close to final and avoids an initial reflow.
            let frame = NSRect::new(
                objc2_foundation::NSPoint::new(0.0, 0.0),
                objc2_foundation::NSSize::new(595.0, 842.0),
            );

            unsafe {
                let config = WKWebViewConfiguration::new(mtm);
                let webview: Retained<WKWebView> = WKWebView::initWithFrame_configuration(
                    WKWebView::alloc(mtm),
                    frame,
                    &config,
                );

                let delegate =
                    NavDelegate::new(mtm, webview.clone(), output_path_for_main, sender);
                let proto = ProtocolObject::from_ref(&*delegate);
                webview.setNavigationDelegate(Some(proto));

                let html_ns = NSString::from_str(&html);
                let base_ns = NSString::from_str(&base_url);
                let base_url_obj = NSURL::URLWithString(&base_ns);
                let _ = webview.loadHTMLString_baseURL(&html_ns, base_url_obj.as_deref());

                drop(webview);
                drop(delegate);
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;

        // Resolve the print operation outcome.
        done_rx
            .await
            .map_err(|_| "PDF generation channel closed unexpectedly".to_string())??;

        Ok(Path::new(&output_path)
            .canonicalize()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(output_path))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    app: tauri::AppHandle,
    html: String,
    output_path: String,
    base_url: String,
) -> Result<String, String> {
    imp::export_pdf(app, html, output_path, base_url).await
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(
    _app: tauri::AppHandle,
    _html: String,
    _output_path: String,
    _base_url: String,
) -> Result<String, String> {
    Err("PDF export is only supported on macOS".into())
}
