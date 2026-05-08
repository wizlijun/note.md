//! PDF export via WKWebView's createPDF API.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, wait for navigation completion, call createPDF,
//! and write the result to the user-chosen path.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::RefCell;
    use std::path::Path;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2_foundation::{
        MainThreadMarker, NSData, NSError, NSObject, NSObjectProtocol, NSRect, NSString, NSURL,
    };
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView,
        WKWebViewConfiguration,
    };

    /// Ivars held by the navigation delegate.
    ///
    /// The delegate strongly retains the webview so the webview lives until
    /// PDF generation finishes. The delegate retains *itself* so the
    /// `setNavigationDelegate:` weak ref doesn't matter — we hand off
    /// ownership to the delegate, and it self-destructs in the completion
    /// block by clearing `self_ref`.
    ///
    /// All access happens on the main thread; the `RefCell`/`Mutex` are
    /// purely for the type-system requirement that ivars on a class be
    /// `Sync` in some scenarios.
    pub(super) struct DelegateIvars {
        webview: RefCell<Option<Retained<WKWebView>>>,
        self_ref: RefCell<Option<Retained<NavDelegate>>>,
        sender: Mutex<Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>>>,
    }

    impl DelegateIvars {
        fn take_sender(
            &self,
        ) -> Option<tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>> {
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
                self.start_pdf_capture();
            }

            #[unsafe(method(webView:didFailNavigation:withError:))]
            fn did_fail(
                &self,
                _webview: &WKWebView,
                _nav: Option<&WKNavigation>,
                error: &NSError,
            ) {
                let msg = error.localizedDescription().to_string();
                if let Some(sender) = self.ivars().take_sender() {
                    let _ = sender.send(Err(format!("WKWebView navigation failed: {msg}")));
                }
                // Drop the webview and break the self-retain so we deallocate.
                let _ = self.ivars().take_webview();
                let _ = self.ivars().take_self_ref();
            }

            #[unsafe(method(webView:didFailProvisionalNavigation:withError:))]
            fn did_fail_provisional(
                &self,
                _webview: &WKWebView,
                _nav: Option<&WKNavigation>,
                error: &NSError,
            ) {
                let msg = error.localizedDescription().to_string();
                if let Some(sender) = self.ivars().take_sender() {
                    let _ = sender.send(Err(format!(
                        "WKWebView provisional navigation failed: {msg}"
                    )));
                }
                let _ = self.ivars().take_webview();
                let _ = self.ivars().take_self_ref();
            }
        }
    );

    impl NavDelegate {
        fn new(
            mtm: MainThreadMarker,
            webview: Retained<WKWebView>,
            sender: tokio::sync::oneshot::Sender<Result<Vec<u8>, String>>,
        ) -> Retained<Self> {
            let ivars = DelegateIvars {
                webview: RefCell::new(Some(webview)),
                self_ref: RefCell::new(None),
                sender: Mutex::new(Some(sender)),
            };
            let this = Self::alloc(mtm).set_ivars(ivars);
            let retained: Retained<Self> = unsafe { msg_send![super(this), init] };
            // Install the self-retain so the delegate stays alive for the
            // duration of the load + PDF capture. Cleared in the completion
            // block (or one of the failure paths).
            *retained.ivars().self_ref.borrow_mut() = Some(retained.clone());
            retained
        }

        /// Called from `didFinishNavigation:` (main thread). Kicks off
        /// `createPDFWithConfiguration:completionHandler:` and arranges for
        /// the completion block to ship bytes back to the awaiting future.
        fn start_pdf_capture(&self) {
            let mtm = self.mtm();

            let webview = match self.ivars().webview.borrow().as_ref() {
                Some(w) => w.clone(),
                None => {
                    if let Some(sender) = self.ivars().take_sender() {
                        let _ = sender
                            .send(Err("WKWebView dropped before PDF capture".into()));
                    }
                    let _ = self.ivars().take_self_ref();
                    return;
                }
            };

            // Clone the self-retain into the block; the block keeps the
            // delegate alive until WebKit invokes the completion handler.
            let self_for_block: Retained<NavDelegate> = self
                .ivars()
                .self_ref
                .borrow()
                .as_ref()
                .expect("self_ref must be set before nav delegate fires")
                .clone();

            let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                let result: Result<Vec<u8>, String> = if !err.is_null() {
                    let err_obj = unsafe { &*err };
                    let msg = err_obj.localizedDescription().to_string();
                    Err(msg)
                } else if !data.is_null() {
                    let nsdata = unsafe { &*data };
                    Ok(nsdata.to_vec())
                } else {
                    Err("createPDF returned no data and no error".into())
                };

                if let Some(sender) = self_for_block.ivars().take_sender() {
                    let _ = sender.send(result);
                }
                // Drop the webview, then break the self-retain so the
                // delegate deallocates after the block returns.
                let _ = self_for_block.ivars().take_webview();
                let _ = self_for_block.ivars().take_self_ref();
            });

            unsafe {
                let config = WKPDFConfiguration::new(mtm);
                webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
            }
        }
    }

    pub async fn export_pdf(
        app: tauri::AppHandle,
        html: String,
        output_path: String,
        base_url: String,
    ) -> Result<String, String> {
        let (done_tx, done_rx) =
            tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

        // Wrap the sender so we can move it into the `FnOnce + Send`
        // closure dispatched to the main thread.
        let sender_holder = std::sync::Mutex::new(Some(done_tx));

        app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new()
                .expect("run_on_main_thread closure must run on main thread");

            let sender = match sender_holder.lock().ok().and_then(|mut g| g.take()) {
                Some(s) => s,
                None => return,
            };

            // Letter-ish frame in points; the actual paginated size is driven
            // by the page CSS (@page rule in the print stylesheet).
            let frame = NSRect::new(
                objc2_foundation::NSPoint::new(0.0, 0.0),
                objc2_foundation::NSSize::new(612.0, 792.0),
            );

            unsafe {
                let config = WKWebViewConfiguration::new(mtm);
                let webview: Retained<WKWebView> = WKWebView::initWithFrame_configuration(
                    WKWebView::alloc(mtm),
                    frame,
                    &config,
                );

                let delegate = NavDelegate::new(mtm, webview.clone(), sender);
                let proto = ProtocolObject::from_ref(&*delegate);
                webview.setNavigationDelegate(Some(proto));

                let html_ns = NSString::from_str(&html);
                let base_ns = NSString::from_str(&base_url);
                let base_url_obj = NSURL::URLWithString(&base_ns);
                let _ = webview
                    .loadHTMLString_baseURL(&html_ns, base_url_obj.as_deref());

                // Drop our local strong refs. The delegate's ivars hold the
                // webview, and the delegate self-retains via `self_ref` —
                // both clear themselves in the PDF completion block.
                drop(webview);
                drop(delegate);
            }
        })
        .map_err(|e| format!("run_on_main_thread failed: {e}"))?;

        let bytes = done_rx
            .await
            .map_err(|_| "PDF generation channel closed unexpectedly".to_string())??;

        std::fs::write(&output_path, bytes)
            .map_err(|e| format!("Failed to write PDF: {e}"))?;

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
