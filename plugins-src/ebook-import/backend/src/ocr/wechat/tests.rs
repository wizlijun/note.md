use super::*;
use crate::ocr::OcrProgress;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

/// Fake [`PageRenderer`] used in place of [`crate::ocr::quartz::QuartzRenderer`]:
/// writes `count` tiny 1x1 PNGs (via the `image` crate, so they're real,
/// decodable PNG files) into `out_dir` and returns them in page order,
/// without touching a real PDF or CoreGraphics.
struct FakeRenderer {
    count: usize,
}

impl PageRenderer for FakeRenderer {
    fn render_pages(&self, _pdf: &Path, out_dir: &Path) -> Result<Vec<PathBuf>, String> {
        std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
        let mut paths = Vec::with_capacity(self.count);
        for i in 1..=self.count {
            let path = out_dir.join(format!("page_{i:04}.png"));
            image::DynamicImage::ImageRgb8(image::RgbImage::new(1, 1))
                .save_with_format(&path, image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            paths.push(path);
        }
        Ok(paths)
    }
}

/// Starts a mock OCR server on an ephemeral `127.0.0.1` port that hands out
/// `responses` -- one canned JSON body per accepted connection, in order --
/// then closes each connection. Returns the server's base URL and a shared
/// counter of accepted connections so tests can assert exactly how many
/// HTTP requests were made (the resume test relies on this to prove a
/// cached page never hits the network).
fn start_mock_server(responses: Vec<String>) -> (String, Arc<AtomicUsize>) {
    start_scripted_server(
        responses
            .into_iter()
            .map(|body| Some(http_response(200, &body)))
            .collect(),
    )
}

fn http_response(status: u16, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

/// None closes the connection without a response, reproducing the observed
/// remote disconnect. Some sends raw HTTP, including deliberately truncated bodies.
fn start_scripted_server(responses: Vec<Option<String>>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock OCR server");
    let addr = listener.local_addr().unwrap();
    let counter = Arc::new(AtomicUsize::new(0));
    let counter_for_thread = counter.clone();

    thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            counter_for_thread.fetch_add(1, Ordering::SeqCst);
            drain_request(&mut stream);
            if let Some(response) = response {
                let _ = stream.write_all(response.as_bytes());
            }
        }
    });

    (format!("http://{addr}"), counter)
}

/// Reads (and discards) one HTTP request off `stream`: headers first up to
/// the blank line, then exactly `Content-Length` more bytes if that header
/// is present. This is a mock, not a real HTTP server -- the multipart
/// bodies these tests send are tiny (a 1x1 PNG), so a byte-at-a-time header
/// scan followed by one `read_exact` is plenty robust.
fn drain_request(stream: &mut TcpStream) {
    let mut header_bytes = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return, // peer half-closed before finishing headers
            Ok(_) => {
                header_bytes.push(byte[0]);
                if header_bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            Err(_) => return,
        }
    }

    let headers = String::from_utf8_lossy(&header_bytes).to_lowercase();
    let content_length: usize = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length:"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);

    if content_length > 0 {
        let mut body = vec![0u8; content_length];
        let _ = stream.read_exact(&mut body);
    }
}

fn engine(url: String, page_count: usize) -> WeChatOcr {
    WeChatOcr {
        url,
        renderer: Box::new(FakeRenderer { count: page_count }),
        timeout: Duration::from_secs(5),
        cancelled: Arc::new(AtomicBool::new(false)),
    }
}

/// Builds the canned JSON body a mock page response would send:
/// `{"success":true,"content":"<content>"}`.
fn ok_body(content: &str) -> String {
    format!("{{\"success\":true,\"content\":\"{content}\"}}")
}

/// The canned JSON body for a page the OCR endpoint reports as failed.
fn fail_body() -> String {
    "{\"success\":false}".to_string()
}

#[test]
fn all_pages_succeed_merge_in_order_and_report_progress() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    let (url, counter) = start_mock_server(vec![ok_body("# p1"), ok_body("# p2"), ok_body("# p3")]);

    let mut pages_seen = Vec::new();
    let result = engine(url, 3)
        .ocr_pdf(Path::new("fake.pdf"), &work, &mut |p| {
            if let OcrProgress::Page { done, total } = p {
                pages_seen.push((done, total));
            }
        })
        .expect("all pages succeeding must be Ok");

    assert_eq!(result, "# p1\n\n# p2\n\n# p3");
    assert_eq!(counter.load(Ordering::SeqCst), 3, "one request per page");
    assert_eq!(pages_seen, vec![(1, 3), (2, 3), (3, 3)]);
}

#[test]
fn preexisting_page_md_is_skipped_and_never_requested() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();
    // Simulates resuming after an earlier run that already produced page 2.
    std::fs::write(work.join("page0002.md"), "cached").unwrap();

    let (url, counter) = start_mock_server(vec![ok_body("# p1"), ok_body("# p3")]);

    let result = engine(url, 3)
        .ocr_pdf(Path::new("fake.pdf"), &work, &mut |_| {})
        .expect("resume run must be Ok");

    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "the cached page must not trigger an HTTP request"
    );
    assert_eq!(result, "# p1\n\ncached\n\n# p3");
}

#[test]
fn a_failed_page_prevents_partial_success_and_preserves_completed_pages() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    let (url, counter) = start_mock_server(vec![ok_body("# p1"), fail_body()]);

    let mut statuses = Vec::new();
    let result = engine(url, 3)
        .ocr_pdf(Path::new("fake.pdf"), &work, &mut |p| {
            if let OcrProgress::Status(s) = p {
                statuses.push(s);
            }
        })
        .expect_err("a missing page must not be reported as a complete book");

    assert!(result.starts_with("OCR incomplete:"), "{result}");
    assert!(result.contains("[2]"), "{result}");
    assert_eq!(
        std::fs::read_to_string(work.join("page0001.md")).unwrap(),
        "# p1"
    );
    assert!(!work.join("page0003.md").exists());
    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "permanent rejection stops further requests"
    );
    assert!(
        !work.join("page0002.md").exists(),
        "a failed page must not leave a pageNNNN.md behind"
    );
    assert!(
        statuses.iter().any(|s| s.starts_with("page 2 failed:")),
        "expected a failed-pages status naming page 2, got {statuses:?}"
    );
}

#[test]
fn every_page_failing_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    let (url, _counter) = start_mock_server(vec![fail_body(), fail_body()]);

    let result = engine(url, 2).ocr_pdf(Path::new("fake.pdf"), &work, &mut |_| {});

    assert!(result.is_err(), "zero successful pages must be an Err");
}

#[test]
fn a_precancelled_run_returns_err_without_making_any_request() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    // No responses queued -- if `ocr_pdf` made even one request, `accept()`
    // would hang until this thread's mock server loop exits, not panic; the
    // `counter == 0` assertion below is what actually pins "no request".
    let (url, counter) = start_mock_server(vec![]);

    let mut e = engine(url, 3);
    e.cancelled = Arc::new(AtomicBool::new(true));

    let result = e.ocr_pdf(Path::new("fake.pdf"), &work, &mut |_| {});

    assert_eq!(result, Err("cancelled".to_string()));
    assert_eq!(
        counter.load(Ordering::SeqCst),
        0,
        "a pre-cancelled run must not make any OCR request"
    );
}

/// Finding 2 (final review): off-network, the default (intranet) OCR URL
/// would otherwise hang for the full per-page timeout on every single page.
/// A bound-then-dropped listener gives us a port nothing is listening on, so
/// connecting fails immediately with "connection refused". The engine must
/// stop after bounded retries of page 1, not plough through all 10 pages.
#[test]
fn an_unreachable_service_stops_after_bounded_same_page_retries() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    let addr = {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        listener.local_addr().unwrap()
        // listener drops here, freeing the port with nothing accepting on it
    };
    let url = format!("http://{addr}");

    let mut pages_seen = Vec::new();
    let start = Instant::now();
    let result = engine(url, 10).ocr_pdf(Path::new("fake.pdf"), &work, &mut |p| {
        if let OcrProgress::Page { done, .. } = p {
            pages_seen.push(done);
        }
    });

    let err = result.expect_err("an unreachable OCR service must abort with Err");
    assert!(
        err.starts_with("OCR incomplete:") && err.contains("3 attempts"),
        "expected the circuit-breaker error, got: {err}"
    );
    assert!(
        pages_seen.is_empty(),
        "failed pages must not report completion: {pages_seen:?}"
    );
    assert!(
        start.elapsed() < Duration::from_secs(5),
        "connection-refused must fail fast, not wait out connect_timeout/timeout"
    );
}

#[test]
fn a_cancel_flag_set_mid_run_stops_before_the_next_page() {
    let tmp = tempfile::tempdir().unwrap();
    let work = tmp.path().join("work");
    std::fs::create_dir_all(&work).unwrap();

    let (url, counter) = start_mock_server(vec![ok_body("# p1"), ok_body("# p2"), ok_body("# p3")]);

    let mut e = engine(url, 3);
    let cancel_flag = Arc::new(AtomicBool::new(false));
    e.cancelled = cancel_flag.clone();

    // Cancel right after page 1 reports progress -- the loop must notice
    // at the top of the *next* iteration, before page 2's request.
    let result = e.ocr_pdf(Path::new("fake.pdf"), &work, &mut move |p| {
        if let OcrProgress::Page { done: 1, .. } = p {
            cancel_flag.store(true, Ordering::Relaxed);
        }
    });

    assert_eq!(result, Err("cancelled".to_string()));
    assert_eq!(
        counter.load(Ordering::SeqCst),
        1,
        "must stop after page 1's request, before page 2's"
    );
}

#[test]
fn disconnected_requests_retry_the_same_page_before_advancing() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) = start_scripted_server(vec![
        None,
        None,
        Some(http_response(200, &ok_body("p1"))),
        Some(http_response(200, &ok_body("p2"))),
    ]);
    let mut statuses = Vec::new();
    let result = engine(url, 2)
        .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |p| {
            if let OcrProgress::Status(s) = p {
                statuses.push(s);
            }
        })
        .expect("transient disconnects must recover on the same page");
    assert_eq!(result, "p1\n\np2");
    assert_eq!(counter.load(Ordering::SeqCst), 4);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| s.starts_with("page 1 retry "))
            .count(),
        2
    );
}

#[test]
fn exhausted_retries_stop_requests_and_resume_from_completed_cache() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) = start_scripted_server(vec![
        Some(http_response(200, &ok_body("p1"))),
        None,
        None,
        None,
        Some(http_response(200, &ok_body("p2"))),
        Some(http_response(200, &ok_body("p3"))),
    ]);
    let e = engine(url, 3);
    let err = e
        .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
        .unwrap_err();
    assert!(err.starts_with("OCR incomplete:"), "{err}");
    assert!(
        err.contains("page 2") && err.contains("3 attempts"),
        "{err}"
    );
    assert!(
        err.contains("source:"),
        "underlying transport error must be retained: {err}"
    );
    assert_eq!(
        counter.load(Ordering::SeqCst),
        4,
        "stop on the exhausted page"
    );
    assert!(!tmp.path().join("page0002.md").exists());
    assert_eq!(
        e.ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
            .unwrap(),
        "p1\n\np2\n\np3"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 6, "resume must skip page 1");
}

#[test]
fn temporary_http_errors_retry_but_permanent_errors_do_not() {
    for status in [408, 429, 500, 503] {
        let tmp = tempfile::tempdir().unwrap();
        let (url, counter) = start_scripted_server(vec![
            Some(http_response(status, "busy")),
            Some(http_response(200, &ok_body("recovered"))),
        ]);
        let result = engine(url, 1).ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {});
        assert_eq!(result, Ok("recovered".to_string()), "HTTP {status}");
        assert_eq!(counter.load(Ordering::SeqCst), 2);
    }
    for status in [400, 401, 403, 404] {
        let tmp = tempfile::tempdir().unwrap();
        // Even an apparently successful JSON body cannot override HTTP failure.
        let (url, counter) =
            start_scripted_server(vec![Some(http_response(status, &ok_body("wrong")))]);
        let err = engine(url, 1)
            .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
            .unwrap_err();
        assert!(
            err.starts_with("OCR incomplete:") && err.contains(&format!("HTTP {status}")),
            "{err}"
        );
        assert_eq!(counter.load(Ordering::SeqCst), 1);
        assert!(!tmp.path().join("page0001.md").exists());
    }
}

#[test]
fn truncated_response_retries_but_invalid_json_does_not() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) = start_scripted_server(vec![
        Some(
            "HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"success\":"
                .to_string(),
        ),
        Some(http_response(200, &ok_body("complete"))),
    ]);
    assert_eq!(
        engine(url, 1).ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {}),
        Ok("complete".to_string())
    );
    assert_eq!(counter.load(Ordering::SeqCst), 2);

    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) = start_mock_server(vec!["not json".to_string()]);
    let err = engine(url, 1)
        .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
        .unwrap_err();
    assert!(err.contains("parse OCR response json"), "{err}");
    assert_eq!(counter.load(Ordering::SeqCst), 1);
}

#[test]
fn cancellation_during_retry_stops_before_another_request() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) =
        start_scripted_server(vec![None, Some(http_response(200, &ok_body("unused")))]);
    let e = engine(url, 1);
    let flag = e.cancelled.clone();
    let start = Instant::now();
    let result = e.ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |p| {
        if let OcrProgress::Status(s) = p {
            if s.starts_with("page 1 retry ") {
                let flag = flag.clone();
                thread::spawn(move || {
                    thread::sleep(Duration::from_millis(100));
                    flag.store(true, Ordering::Relaxed);
                });
            }
        }
    });
    assert_eq!(result, Err("cancelled".to_string()));
    assert_eq!(counter.load(Ordering::SeqCst), 1);
    assert!(start.elapsed() < Duration::from_millis(750));
}

#[test]
fn merge_uses_only_expected_pages_and_accepts_successful_blank_pages() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("page0003.md"), "stale").unwrap();
    std::fs::write(tmp.path().join("page-not-a-page.md"), "unrelated").unwrap();
    let (url, _) = start_mock_server(vec![ok_body("p1"), ok_body("")]);
    assert_eq!(
        engine(url, 2)
            .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
            .unwrap(),
        "p1\n\n"
    );
}

#[test]
fn a_reused_connection_disconnect_recovers_on_a_fresh_connection() {
    let tmp = tempfile::tempdir().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(AtomicUsize::new(0));
    let count = requests.clone();
    let server = thread::spawn(move || {
        let (mut reused, _) = listener.accept().unwrap();
        reused
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        drain_request(&mut reused);
        count.fetch_add(1, Ordering::SeqCst);
        reused
            .write_all(
                http_response(200, &ok_body("p1"))
                    .replace("Connection: close", "Connection: keep-alive")
                    .as_bytes(),
            )
            .unwrap();
        // The next page is fully received on this same connection, then the
        // peer closes without a response, just as observed on the OCR service.
        drain_request(&mut reused);
        count.fetch_add(1, Ordering::SeqCst);
        drop(reused);
        let (mut fresh, _) = listener.accept().unwrap();
        drain_request(&mut fresh);
        count.fetch_add(1, Ordering::SeqCst);
        fresh
            .write_all(http_response(200, &ok_body("p2")).as_bytes())
            .unwrap();
    });
    let mut retries = Vec::new();
    let result = engine(url, 2)
        .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |p| {
            if let OcrProgress::Status(s) = p {
                retries.push(s);
            }
        })
        .unwrap();
    server.join().unwrap();
    assert_eq!(result, "p1\n\np2");
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert!(
        retries.iter().any(|s| s.starts_with("page 2 retry 2/3:")),
        "{retries:?}"
    );
}

#[test]
fn cancellation_while_a_request_fails_is_reported_as_cancelled() {
    for response in [
        None,
        Some(http_response(400, "invalid request")),
        Some(http_response(200, &ok_body("unused"))),
    ] {
        let tmp = tempfile::tempdir().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let e = engine(format!("http://{}", listener.local_addr().unwrap()), 1);
        let flag = e.cancelled.clone();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            drain_request(&mut stream);
            flag.store(true, Ordering::Relaxed);
            if let Some(response) = response {
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        let result = e.ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {});
        server.join().unwrap();
        assert_eq!(result, Err("cancelled".to_string()));
        assert!(
            !tmp.path().join("page0001.md").exists(),
            "cancelled response must not become a checkpoint"
        );
    }
}

#[test]
fn sustained_server_errors_exhaust_only_the_current_page() {
    let tmp = tempfile::tempdir().unwrap();
    let (url, counter) = start_scripted_server(
        (0..3)
            .map(|_| Some(http_response(503, "unavailable")))
            .collect(),
    );
    let err = engine(url, 100)
        .ocr_pdf(Path::new("fake.pdf"), tmp.path(), &mut |_| {})
        .unwrap_err();
    assert!(
        err.starts_with("OCR incomplete:")
            && err.contains("HTTP 503")
            && err.contains("3 attempts"),
        "{err}"
    );
    assert_eq!(counter.load(Ordering::SeqCst), 3);
    assert!(!tmp.path().join("page0001.md").exists());
}

#[test]
fn early_http_rejection_during_a_large_upload_keeps_the_real_status() {
    let tmp = tempfile::tempdir().unwrap();
    let image = tmp.path().join("upload.png");
    std::fs::write(&image, vec![b'x'; 8 * 1024 * 1024]).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut header = Vec::new();
        let mut byte = [0u8; 1];
        while !header.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).unwrap();
            header.push(byte[0]);
        }
        let header = String::from_utf8(header).unwrap().to_lowercase();
        assert!(header.contains("multipart/form-data; boundary="));
        // Reject before reading the image. A streamed blocking multipart body
        // can lose this response behind its internal SendError::Disconnected.
        stream
            .write_all(
                b"HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        stream.shutdown(std::net::Shutdown::Write).unwrap();
        let mut buffer = [0u8; 8192];
        while let Ok(n) = stream.read(&mut buffer) {
            if n == 0 {
                break;
            }
        }
    });
    let client = engine(url.clone(), 1).build_client().unwrap();
    let result = ocr_one_page(&client, &url, &image);
    server.join().unwrap();
    match result {
        Err(OcrPageError::Rejected(reason)) => assert!(reason.contains("HTTP 413"), "{reason}"),
        Err(OcrPageError::Retryable(reason)) => {
            panic!("permanent HTTP rejection was hidden: {reason}")
        }
        Ok(_) => panic!("HTTP 413 must not become successful OCR"),
    }
}
