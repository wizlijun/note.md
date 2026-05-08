//! PDF export via `NSPrintOperation.PDFOperationWithView:insideRect:toPath:printInfo:`.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, wait for navigation completion, and run a
//! *PDF-specific* `NSPrintOperation` configured for A4 + auto-pagination.
//!
//! Why `PDFOperationWithView:` and not the more obvious paths:
//!
//! - `WKWebView.createPDFWithConfiguration:` captures the entire scroll
//!   region as one tall PDF page — no pagination.
//! - `WKWebView.printOperationWithPrintInfo:` even with NSPrintSaveJob
//!   disposition triggers the system "set up a printer" prompt on Macs
//!   without any installed printer. macOS treats it as a real print
//!   operation and validates against printers.
//! - `+[NSPrintOperation PDFOperationWithView:insideRect:toPath:printInfo:]`
//!   is the PDF-specific factory that writes paginated PDF directly to
//!   disk, bypassing any printer configuration entirely.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::Mutex;

    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{
        NSPrintInfo, NSPrintOperation, NSPrintingPaginationMode, NSPaperOrientation, NSView,
    };
    use objc2_foundation::{
        MainThreadMarker, NSError, NSObject, NSObjectProtocol, NSRect, NSString, NSURL,
    };
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKWebView, WKWebViewConfiguration,
    };

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

        /// Configure NSPrintInfo for A4 + zero outer margins (CSS @page in
        /// pdf.css supplies the visible 25mm/20mm margin) and run a
        /// PDF-specific print operation that writes paginated PDF directly
        /// to disk.
        ///
        /// Uses `+[NSPrintOperation PDFOperationWithView:insideRect:toPath:printInfo:]`
        /// — bypasses the regular print pipeline so it works on Macs with
        /// no printers installed.
        fn run_print_to_pdf(&self) -> Result<(), String> {
            let _ = self.mtm();

            let webview = match self.ivars().webview.borrow().as_ref() {
                Some(w) => w.clone(),
                None => return Err("WKWebView dropped before print".into()),
            };
            let output_path = self.ivars().output_path.clone();

            {
                let print_info: Retained<NSPrintInfo> = NSPrintInfo::new();

                let paper = objc2_foundation::NSSize {
                    width: 595.0,
                    height: 842.0,
                };
                print_info.setPaperSize(paper);
                print_info.setOrientation(NSPaperOrientation::Portrait);

                // Zero outer margins; pdf.css controls visible margins.
                print_info.setTopMargin(0.0);
                print_info.setBottomMargin(0.0);
                print_info.setLeftMargin(0.0);
                print_info.setRightMargin(0.0);

                print_info.setHorizontalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
                print_info.setHorizontallyCentered(false);
                print_info.setVerticallyCentered(false);

                // The full content area to capture. Pagination cuts this
                // into A4 pages automatically.
                let bounds: NSRect = webview.bounds();

                // WKWebView is an NSView subclass — pass it where NSView
                // is expected. The deref to &NSView goes through Retained's
                // Deref → WKWebView → NSView via objc2's class hierarchy.
                let view: &NSView = &*webview;

                let path_ns = NSString::from_str(&output_path);
                let op: Retained<NSPrintOperation> =
                    NSPrintOperation::PDFOperationWithView_insideRect_toPath_printInfo(
                        view,
                        bounds,
                        &path_ns,
                        &print_info,
                    );
                op.setShowsPrintPanel(false);
                op.setShowsProgressPanel(false);

                if !op.runOperation() {
                    return Err("PDFOperationWithView reported failure".into());
                }
            }

            if !Path::new(&output_path).exists() {
                return Err(format!(
                    "PDF operation returned success but no file at {output_path}"
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
