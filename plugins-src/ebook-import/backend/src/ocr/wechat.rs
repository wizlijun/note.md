//! WeChat OCR [`OcrEngine`]. Ports `01_ocr_to_md.py`'s page-at-a-time flow:
//! render every page to a PNG, POST each PNG to a self-hosted WeChat-OCR
//! HTTP endpoint as multipart `file` data, expect back
//! `{"success": bool, "content": "<markdown>"}`, write the per-page
//! markdown to `pageNNNN.md`, then merge the expected pages in order.
//!
//! Completed pages are cached for resume. Transient HTTP/transport errors
//! retry the same page with a fresh client and bounded, cancellable backoff.
//! A failed page never produces a successful but incomplete book.

#[cfg(test)]
mod tests;

use crate::ocr::{OcrEngine, OcrProgress, PageRenderer};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// TCP connect timeout for the OCR HTTP client, distinct from (and much
/// shorter than) `WeChatOcr::timeout` (the whole-request timeout, which also
/// has to cover slow OCR processing on a reachable server). Without this,
/// `reqwest`'s default has no connect-specific bound, so an unreachable host
/// (dropped packets, not just "connection refused") would burn the full
/// per-request timeout just failing to connect.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Includes the initial request. Do not multiply a service outage by the
/// number of pages in a book: stop on the first exhausted page.
const MAX_PAGE_ATTEMPTS: usize = 3;

pub struct WeChatOcr {
    pub url: String,
    pub renderer: Box<dyn PageRenderer>,
    pub timeout: Duration,
    /// Checked at the top of `ocr_pdf` and again before every page. Wired to
    /// a job's cancel flag by `plugin.rs::build_engine` (and to `deactivate`
    /// cancelling every live job) -- without this, a cancelled/shutting-down
    /// plugin process's job thread would keep POSTing pages to the OCR
    /// endpoint indefinitely, holding its `Host` clone alive and blocking
    /// `serve_io` from ever completing after `$deactivate`.
    pub cancelled: Arc<AtomicBool>,
}

impl OcrEngine for WeChatOcr {
    fn ocr_pdf(
        &self,
        pdf: &Path,
        work: &Path,
        on: &mut dyn FnMut(OcrProgress),
    ) -> Result<String, String> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }

        let images_dir = work.join("ocr_images");
        std::fs::create_dir_all(&images_dir)
            .map_err(|e| format!("create {}: {e}", images_dir.display()))?;
        let pages = self.renderer.render_pages(pdf, &images_dir)?;
        let total = pages.len();

        if total == 0 {
            return Err("OCR produced no content for any of 0 page(s)".to_string());
        }
        let mut client = self.build_client()?;

        for (idx, image_path) in pages.iter().enumerate() {
            self.check_cancelled()?;
            let page_no = idx + 1;
            let page_md = work.join(format!("page{page_no:04}.md"));

            if !page_md.exists() {
                for attempt in 1..=MAX_PAGE_ATTEMPTS {
                    self.check_cancelled()?;
                    let result = ocr_one_page(&client, &self.url, image_path);
                    self.check_cancelled()?;
                    match result {
                        Ok(content) => {
                            // Only fully written results may become resume checkpoints.
                            let pending = page_md.with_extension("md.tmp");
                            std::fs::write(&pending, content)
                                .map_err(|e| format!("write {}: {e}", pending.display()))?;
                            std::fs::rename(&pending, &page_md)
                                .map_err(|e| format!("save {}: {e}", page_md.display()))?;
                            break;
                        }
                        Err(error) => {
                            let reason = match &error {
                                OcrPageError::Retryable(reason)
                                | OcrPageError::Rejected(reason) => reason,
                            };
                            if matches!(error, OcrPageError::Rejected(_))
                                || attempt == MAX_PAGE_ATTEMPTS
                            {
                                on(OcrProgress::Status(format!(
                                    "page {page_no} failed: {reason}"
                                )));
                                return Err(format!(
                                    "OCR incomplete: failed pages: [{page_no}]; page {page_no} failed after {attempt} attempts; completed {idx} of {total} pages; {reason}"
                                ));
                            }
                            on(OcrProgress::Status(format!(
                                "page {page_no} retry {}/{MAX_PAGE_ATTEMPTS}: {reason}",
                                attempt + 1
                            )));
                            // 1s, then 2s; cancellation must not wait out the backoff.
                            for _ in 0..attempt * 20 {
                                self.check_cancelled()?;
                                std::thread::sleep(Duration::from_millis(50));
                            }
                            self.check_cancelled()?;
                            client = self.build_client()?;
                        }
                    }
                }
            }
            on(OcrProgress::Page {
                done: page_no,
                total,
            });
        }

        merge_pages(work, total)
    }
}

impl WeChatOcr {
    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("cancelled".to_string())
        } else {
            Ok(())
        }
    }

    fn build_client(&self) -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(self.timeout)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| format!("build http client: {e:?}"))
    }
}

/// Temporary transport/HTTP errors can be retried; permanent HTTP or
/// protocol rejections require attention, not another identical request.
enum OcrPageError {
    Retryable(String),
    Rejected(String),
}

/// POST one rendered PNG. Keep transport errors (including interrupted
/// response bodies) distinct from complete but invalid JSON responses.
fn ocr_one_page(
    client: &reqwest::blocking::Client,
    url: &str,
    image_path: &Path,
) -> Result<String, OcrPageError> {
    let bytes = std::fs::read(image_path)
        .map_err(|e| OcrPageError::Rejected(format!("read {}: {e}", image_path.display())))?;
    let file_name = image_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("page.png")
        .to_string();
    let part = reqwest::blocking::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("image/png")
        .map_err(|e| OcrPageError::Rejected(e.to_string()))?;
    let form = reqwest::blocking::multipart::Form::new().part("file", part);

    let resp = client
        .post(url)
        .multipart(form)
        .send()
        // Debug retains reqwest's source chain (Display only prints kind + URL).
        .map_err(|e| OcrPageError::Retryable(format!("POST {url}: {e:?}")))?;
    let status = resp.status();
    if !status.is_success() {
        let reason = format!("POST {url}: HTTP {}", status.as_u16());
        return Err(
            if status.as_u16() == 408 || status.as_u16() == 429 || status.is_server_error() {
                OcrPageError::Retryable(reason)
            } else {
                OcrPageError::Rejected(reason)
            },
        );
    }
    let body = resp
        .bytes()
        .map_err(|e| OcrPageError::Retryable(format!("read OCR response: {e:?}")))?;
    let json: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|e| OcrPageError::Rejected(format!("parse OCR response json: {e}")))?;

    let success = json
        .get("success")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !success {
        return Err(OcrPageError::Rejected(
            "OCR endpoint reported success=false".to_string(),
        ));
    }
    json.get("content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| OcrPageError::Rejected("OCR response missing `content`".to_string()))
}

/// Read only this PDF's expected pages, never unrelated or stale page files.
fn merge_pages(work: &Path, total: usize) -> Result<String, String> {
    let mut parts = Vec::with_capacity(total);
    for page_no in 1..=total {
        let path = work.join(format!("page{page_no:04}.md"));
        parts.push(
            std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?,
        );
    }
    Ok(parts.join("\n\n"))
}
