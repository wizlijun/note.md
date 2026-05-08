//! PDF export via WKWebView's `createPDFWithConfiguration:` + PDFKit merge.
//!
//! Frontend hands us a fully-rendered, self-contained HTML document plus a
//! base URL (file:// of the source file's directory, used so relative-path
//! images can resolve). We spin up an offscreen WKWebView on the main
//! thread, load the HTML, and:
//!
//! 1. After navigation completes, evaluate JavaScript to read
//!    `document.documentElement.scrollHeight` — the full content height.
//! 2. Compute how many A4 pages tall that is.
//! 3. For each page, call `createPDFWithConfiguration:` with a rect
//!    `(0, page_index * 842, 595, 842)`. Each call yields a single-page
//!    PDF as NSData.
//! 4. Merge the per-page PDFs into one multi-page document via PDFKit.
//! 5. Write the merged PDF bytes to disk.
//!
//! Why this dance instead of obvious alternatives:
//!
//! - `WKWebView.createPDFWithConfiguration:` with no rect captures the
//!   entire scroll region as one tall PDF page — no pagination.
//! - `WKWebView.printOperationWithPrintInfo:` requires a printer to be
//!   installed on the system (it validates against printers even with
//!   `NSPrintSaveJob`). Macs without printers get a "Set up a printer"
//!   prompt instead of a save dialog.
//! - `+[NSPrintOperation PDFOperationWithView:insideRect:toPath:printInfo:]`
//!   needs the WKWebView to be window-attached and laid out at full
//!   content height — out-of-window webviews produce blank PDFs.
//!
//! This rect-per-page + PDFKit-merge approach has none of those issues.

#[cfg(target_os = "macos")]
mod imp {
    use std::cell::{Cell, RefCell};
    use std::path::Path;
    use std::sync::Mutex;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadOnly};
    use objc2_foundation::{
        MainThreadMarker, NSData, NSError, NSNumber, NSObject, NSObjectProtocol, NSRect,
        NSString, NSURL,
    };
    use objc2_pdf_kit::{PDFDisplayBox, PDFDocument, PDFPage};
    use objc2_web_kit::{
        WKNavigation, WKNavigationDelegate, WKPDFConfiguration, WKWebView,
        WKWebViewConfiguration,
    };

    /// A4 page size in PostScript points (1pt = 1/72 inch).
    const A4_W: f64 = 595.0;
    const A4_H: f64 = 842.0;
    /// Visible margins inside each A4 page. ~20mm horizontal, ~25mm vertical
    /// at 1pt = 1/72 inch (1mm ≈ 2.835pt).
    const MARGIN_H: f64 = 57.0;
    const MARGIN_V: f64 = 71.0;
    /// Inner content area = A4 minus margins. The webview renders into this
    /// width; pages are captured this tall.
    const INNER_W: f64 = A4_W - 2.0 * MARGIN_H; // 481
    const INNER_H: f64 = A4_H - 2.0 * MARGIN_V; // 700

    /// Ivars held by the navigation delegate. Holds enough state to drive
    /// the multi-stage async capture (height-measure → per-page createPDF
    /// loop → merge + write).
    pub(super) struct DelegateIvars {
        webview: RefCell<Option<Retained<WKWebView>>>,
        self_ref: RefCell<Option<Retained<NavDelegate>>>,
        sender: Mutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>,
        output_path: String,

        /// Per-page captured PDF NSData buffers, in order.
        pages: RefCell<Vec<Retained<NSData>>>,
        num_pages: Cell<usize>,
        current_page: Cell<usize>,
    }

    impl DelegateIvars {
        fn take_sender(&self) -> Option<tokio::sync::oneshot::Sender<Result<(), String>>> {
            self.sender.lock().ok().and_then(|mut g| g.take())
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
                self.start_height_measurement();
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
                pages: RefCell::new(Vec::new()),
                num_pages: Cell::new(0),
                current_page: Cell::new(0),
            };
            let this = Self::alloc(mtm).set_ivars(ivars);
            let retained: Retained<Self> = unsafe { msg_send![super(this), init] };
            // Self-retain for the duration of the async chain.
            *retained.ivars().self_ref.borrow_mut() = Some(retained.clone());
            retained
        }

        /// Send result + tear down. Idempotent.
        fn dispatch_result(&self, result: Result<(), String>) {
            if let Some(sender) = self.ivars().take_sender() {
                let _ = sender.send(result);
            }
            let _ = self.ivars().webview.borrow_mut().take();
            let _ = self.ivars().self_ref.borrow_mut().take();
        }

        /// Step 1: ask the page how tall its content is.
        fn start_height_measurement(&self) {
            let webview = match self.ivars().webview.borrow().as_ref() {
                Some(w) => w.clone(),
                None => {
                    self.dispatch_result(Err("WKWebView dropped before height read".into()));
                    return;
                }
            };

            let self_for_block: Retained<NavDelegate> = self
                .ivars()
                .self_ref
                .borrow()
                .as_ref()
                .expect("self_ref set before nav finish")
                .clone();

            let block = RcBlock::new(move |result: *mut AnyObject, err: *mut NSError| {
                if !err.is_null() {
                    let err_obj = unsafe { &*err };
                    let msg = err_obj.localizedDescription().to_string();
                    self_for_block
                        .dispatch_result(Err(format!("evaluateJavaScript failed: {msg}")));
                    return;
                }
                if result.is_null() {
                    self_for_block.dispatch_result(Err(
                        "evaluateJavaScript returned no result".into(),
                    ));
                    return;
                }
                // The result is an NSNumber (scrollHeight is a number).
                let number = unsafe { &*(result as *mut NSNumber) };
                let height: f64 = number.doubleValue();

                // Compute number of pages by inner content height
                // (content area, not full A4) — PDFKit pads each captured
                // page out to A4 with margins later.
                let num_pages =
                    ((height / INNER_H as f64).ceil() as usize).max(1);
                self_for_block.ivars().num_pages.set(num_pages);
                self_for_block.ivars().current_page.set(0);

                self_for_block.capture_next_page();
            });

            let js = NSString::from_str("document.documentElement.scrollHeight");
            unsafe {
                webview.evaluateJavaScript_completionHandler(&js, Some(&block));
            }
        }

        /// Step 2 (loop): capture the current page's slice as a single-page PDF.
        fn capture_next_page(&self) {
            let i = self.ivars().current_page.get();
            let n = self.ivars().num_pages.get();
            if i >= n {
                self.finalize();
                return;
            }

            let webview = match self.ivars().webview.borrow().as_ref() {
                Some(w) => w.clone(),
                None => {
                    self.dispatch_result(Err("WKWebView dropped during page capture".into()));
                    return;
                }
            };

            let rect = NSRect::new(
                objc2_foundation::NSPoint::new(0.0, i as f64 * INNER_H),
                objc2_foundation::NSSize::new(INNER_W, INNER_H),
            );

            let self_for_block: Retained<NavDelegate> = self
                .ivars()
                .self_ref
                .borrow()
                .as_ref()
                .expect("self_ref set during page capture")
                .clone();

            let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                if !err.is_null() {
                    let err_obj = unsafe { &*err };
                    let msg = err_obj.localizedDescription().to_string();
                    self_for_block
                        .dispatch_result(Err(format!("createPDF page failed: {msg}")));
                    return;
                }
                if data.is_null() {
                    self_for_block.dispatch_result(Err(
                        "createPDF returned null data".into(),
                    ));
                    return;
                }
                let nsdata = unsafe { Retained::retain(data).expect("non-null data") };
                self_for_block.ivars().pages.borrow_mut().push(nsdata);
                self_for_block.ivars().current_page.set(i + 1);
                self_for_block.capture_next_page();
            });

            unsafe {
                let config = WKPDFConfiguration::new(self.mtm());
                config.setRect(rect);
                webview.createPDFWithConfiguration_completionHandler(Some(&config), &block);
            }
        }

        /// Step 3: merge all per-page PDFs into one multi-page PDF via
        /// PDFKit, then write the bytes to disk.
        fn finalize(&self) {
            let pieces: Vec<Retained<NSData>> = self.ivars().pages.borrow_mut().drain(..).collect();
            let output_path = self.ivars().output_path.clone();

            let merged = match merge_page_pdfs(&pieces) {
                Ok(d) => d,
                Err(e) => {
                    self.dispatch_result(Err(e));
                    return;
                }
            };

            // Write to disk.
            let bytes: Vec<u8> = merged.to_vec();
            if let Err(e) = std::fs::write(&output_path, bytes) {
                self.dispatch_result(Err(format!("Failed to write PDF: {e}")));
                return;
            }
            if !Path::new(&output_path).exists() {
                self.dispatch_result(Err(format!(
                    "PDF reportedly written but no file at {output_path}"
                )));
                return;
            }
            self.dispatch_result(Ok(()));
        }
    }

    /// Expand a captured single-page PDF's MediaBox so the page becomes A4
    /// with the original content offset by (MARGIN_H, MARGIN_V).
    ///
    /// PDF coordinates: origin is bottom-left. Content drawn at PDF (x, y)
    /// appears at viewer-page (x - mediabox.x, y - mediabox.y). Setting
    /// MediaBox origin to (-MARGIN_H, -MARGIN_V) shifts the displayed
    /// content by (MARGIN_H, MARGIN_V) → visible left/bottom margin.
    /// MediaBox size = A4 → final page is A4-sized with margins on all
    /// four sides (top/right margins emerge automatically because content
    /// is INNER_W × INNER_H, smaller than A4 minus offset).
    fn expand_to_a4_with_margins(page: &PDFPage) {
        let new_media = NSRect::new(
            objc2_foundation::NSPoint::new(-MARGIN_H, -MARGIN_V),
            objc2_foundation::NSSize::new(A4_W, A4_H),
        );
        unsafe {
            page.setBounds_forBox(new_media, PDFDisplayBox::MediaBox);
        }
    }

    /// Merge a sequence of single-page PDF datas into one multi-page PDF.
    /// Each captured page (INNER_W × INNER_H) gets its MediaBox expanded
    /// to A4 (595×842) with the content offset by the margin amounts —
    /// gives every output page clean white margins.
    fn merge_page_pdfs(pieces: &[Retained<NSData>]) -> Result<Retained<NSData>, String> {
        if pieces.is_empty() {
            return Err("no pages to merge".into());
        }

        let combined = unsafe { PDFDocument::new() };
        for (idx, piece) in pieces.iter().enumerate() {
            let alloc = PDFDocument::alloc();
            let single = unsafe { PDFDocument::initWithData(alloc, piece) }
                .ok_or_else(|| format!("PDFDocument::initWithData failed for page {idx}"))?;
            let page = unsafe { single.pageAtIndex(0) }
                .ok_or_else(|| format!("page {idx} missing in single-page PDF"))?;
            expand_to_a4_with_margins(&page);
            let insert_at = unsafe { combined.pageCount() };
            unsafe { combined.insertPage_atIndex(&page, insert_at) };
        }
        let data = unsafe { combined.dataRepresentation() }
            .ok_or_else(|| "merged PDF dataRepresentation returned nil".to_string())?;
        Ok(data)
    }

    /// Helper for converting NSData to Vec<u8>.
    trait NSDataToVec {
        fn to_vec(&self) -> Vec<u8>;
    }
    impl NSDataToVec for Retained<NSData> {
        fn to_vec(&self) -> Vec<u8> {
            (**self).to_vec()
        }
    }

    pub async fn export_pdf(
        app: tauri::AppHandle,
        html: String,
        output_path: String,
        base_url: String,
    ) -> Result<String, String> {
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

        let sender_holder = Mutex::new(Some(done_tx));
        let output_path_for_main = output_path.clone();

        app.run_on_main_thread(move || {
            let mtm = MainThreadMarker::new()
                .expect("run_on_main_thread closure must run on main thread");

            let sender = match sender_holder.lock().ok().and_then(|mut g| g.take()) {
                Some(s) => s,
                None => return,
            };

            // The webview's frame width = inner content area. Content
            // reflows for this width; pages are captured at INNER_H height
            // each, then PDFKit pads each captured page out to A4 with
            // margins. Frame height is incidental.
            let frame = NSRect::new(
                objc2_foundation::NSPoint::new(0.0, 0.0),
                objc2_foundation::NSSize::new(INNER_W, INNER_H),
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
