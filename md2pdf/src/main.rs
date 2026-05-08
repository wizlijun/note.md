//! md2pdf — one-shot CLI plugin that takes a host-rendered inline HTML body
//! plus an output path, and writes a typographically-clean A4 PDF.
//!
//! Protocol mirrors mdshare and the rest of M↓'s plugins:
//!  - read one line of JSON Request from stdin
//!  - perform the work
//!  - emit one line of JSON Response on stdout
//!  - exit
//!
//! Task 10 lands the skeleton with a stub run_export that writes the wrapped
//! HTML to disk so the smoke test verifies stdin/stdout plumbing. Task 11
//! replaces the stub with the real WKWebView + PDFKit pipeline.

mod ipc;
mod template;

use std::io::{self, Read, Write};
use ipc::{Request, Response};

const PLUGIN_NAME: &str = "md2pdf";

fn main() {
    let mut input = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut input) {
        emit(Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 无法读取 stdin"),
            Some(e.to_string()),
        )]));
        return;
    }
    let req: Request = match serde_json::from_str(input.trim()) {
        Ok(r) => r,
        Err(e) => {
            emit(Response::fail(vec![ipc::toast_error(
                format!("❌ {PLUGIN_NAME}: 请求 JSON 解析失败"),
                Some(e.to_string()),
            )]));
            return;
        }
    };

    let resp = match req.command.as_str() {
        "export" => run_export(&req),
        other => Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 未知命令"),
            Some(other.to_string()),
        )]),
    };
    emit(resp);
}

fn run_export(req: &Request) -> Response {
    // Stub: write the wrapped HTML to the output path so the smoke test can
    // verify the request → response round-trip without yet pulling in
    // WKWebView. Task 11 swaps this for the real PDF pipeline.
    let html = template::wrap_html(&req.context.rendered_html, &req.context.tab.title);
    match std::fs::write(&req.context.output_path, html.as_bytes()) {
        Ok(()) => Response::ok(vec![ipc::toast_success(
            format!("✅ 已导出到 {}", req.context.output_path),
        )]),
        Err(e) => Response::fail(vec![ipc::toast_error(
            format!("❌ {PLUGIN_NAME}: 写入失败"),
            Some(e.to_string()),
        )]),
    }
}

fn emit(resp: Response) {
    let s = serde_json::to_string(&resp).expect("serialize response");
    let stdout = io::stdout();
    let mut h = stdout.lock();
    h.write_all(s.as_bytes()).expect("write stdout");
    h.write_all(b"\n").expect("write newline");
}
