use std::io::Write;
use std::process::{Command, Stdio};

fn binary() -> std::path::PathBuf {
    let target = std::env::var("CARGO_BIN_EXE_mdshare")
        .expect("CARGO_BIN_EXE_mdshare set by cargo test");
    std::path::PathBuf::from(target)
}

fn run_with_input(input: &str) -> String {
    let mut child = Command::new(binary())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn mdshare");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(input.as_bytes())
        .expect("write stdin");
    let out = child.wait_with_output().expect("wait");
    assert!(out.status.success());
    String::from_utf8(out.stdout).expect("utf8 stdout")
}

#[test]
fn copy_link_returns_clipboard_action() {
    let req = r#"{
      "command":"copy-link",
      "context":{"tab":{"path":"/p.md","filename":"p.md"}},
      "settings":{"share.records":{"/p.md":{"slug":"s","edit_token":"e","url":"https://x/s","filename":"p.md"}}}
    }"#;
    let out = run_with_input(req);
    assert!(out.contains("\"clipboard.write\""));
    assert!(out.contains("https://x/s"));
}

#[test]
fn copy_link_without_record_fails() {
    let req = r#"{"command":"copy-link","context":{"tab":{"path":"/p.md","filename":"p.md"}},"settings":{}}"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("未分享过"));
}

#[test]
fn unknown_command_fails() {
    let req = r#"{"command":"explode","context":{"tab":{"path":null,"filename":null}}}"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("未知命令"));
}

#[test]
fn invalid_json_fails_gracefully() {
    let out = run_with_input("not json");
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("解析失败"));
}

#[test]
fn publish_without_baseurl_fails() {
    let req = r#"{
      "command":"publish",
      "context":{"tab":{"path":"/p.md","filename":"p.md"},"rendered_html":"<p>x</p>"},
      "settings":{}
    }"#;
    let out = run_with_input(req);
    assert!(out.contains("\"success\":false"));
    assert!(out.contains("Service Base URL"));
}
