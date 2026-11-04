//! End-to-end test for `notemd mcp` — the stdio shell (`mcp::shim::run_shim`)
//! reached through the *real* CLI routing (`cli::router` → `cli::builtin` →
//! `mcp::shim::run_shim`), driven over an actual stdin/stdout pipe to the
//! built binary.
//!
//! This exists because every other test around this feature stops short of
//! the shell itself: `router.rs`'s tests only check routing (never call
//! `run_shim`), and `dispatch.rs`'s tests call `dispatch::handle` directly,
//! bypassing the shell's stdin loop entirely. The one property that
//! `shim.rs` exists to deliver — `initialize`/`tools/list` answer from the
//! compiled-in static schema so the tool list survives a closed GUI, while
//! only `tools/call` needs IPC — had no regression coverage: an edit that
//! accidentally routed `tools/list` through `forward()` would have passed
//! `cargo test` and broken every agent whose note.md happens to be closed at
//! session start.
//!
//! Follows the binary-spawning + HOME-isolation pattern established in
//! `cli_builtin_integration.rs`; unix-only for the same reason that file is
//! (see its header — `dirs::config_dir()`/`data_dir()` on Windows ignore an
//! overridden `%APPDATA%` in the child environment, so isolation there needs
//! a different mechanism this test doesn't have).
#![cfg(unix)]

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_notemd"))
}

fn temp_home() -> PathBuf {
    std::env::temp_dir().join(format!(
        "notemd-mcp-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ))
}

/// Spawns `notemd --cli mcp`, writes every line of `lines` to its stdin (one
/// JSON-RPC message per line, exactly as a real MCP client would frame them),
/// closes stdin so the shell's read loop sees EOF and exits, then collects
/// exit code + every non-empty stdout line (each is one JSON-RPC reply).
///
/// `HOME` points at a fresh temp dir and `XDG_RUNTIME_DIR` is removed, so the
/// IPC endpoint this process resolves (`platform::ipc::endpoint`) can never
/// collide with a real note.md instance's socket that happens to be running
/// on the same machine (observed in the wild during manual smoke-testing on
/// this very machine) — this test's `tools/call` MUST see an unreachable GUI,
/// not accidentally succeed against someone else's live vault.
fn run_mcp_session(lines: &[&str], home: &PathBuf) -> (i32, Vec<String>, String) {
    std::fs::create_dir_all(home).unwrap();
    let mut cmd = Command::new(binary_path());
    cmd.args(["--cli", "mcp"]);
    cmd.env_remove("HOME");
    cmd.env("HOME", home.to_str().unwrap());
    cmd.env_remove("XDG_RUNTIME_DIR");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().expect("spawn binary");

    {
        let stdin = child.stdin.as_mut().expect("stdin is piped");
        for line in lines {
            writeln!(stdin, "{line}").expect("write to child stdin");
        }
    }
    // Explicit EOF: the shell's read loop (`next_msg`) exits on a 0-byte
    // read, which only happens once the write end of the pipe is closed.
    drop(child.stdin.take());

    let out = child.wait_with_output().expect("wait for child");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let reply_lines: Vec<String> =
        stdout.lines().map(|s| s.to_string()).filter(|s| !s.trim().is_empty()).collect();
    (out.status.code().unwrap_or(-1), reply_lines, stderr)
}

/// The core contract: with no GUI reachable, a single session that mixes
/// several message shapes — a real request, a notification (no id, no
/// reply), a line of garbage, and two more real requests — is answered
/// correctly and in order. This is what actually exercises the shell's
/// stdin loop, not just one line in isolation.
#[test]
fn session_answers_without_gui_and_survives_garbage_input() {
    let home = temp_home();
    let (code, replies, stderr) = run_mcp_session(
        &[
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}"#,
            "this is not json",
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"vault_info","arguments":{}}}"#,
        ],
        &home,
    );
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(code, 0, "stderr was: {stderr}");
    // Exactly 4 replies: the notification produces none, everything else
    // (including the garbage line) produces exactly one each.
    assert_eq!(replies.len(), 4, "replies were: {replies:?}");

    let msgs: Vec<serde_json::Value> =
        replies.iter().map(|l| serde_json::from_str(l).expect(l)).collect();

    // 1) initialize — answered without a GUI.
    assert_eq!(msgs[0]["id"], 1);
    assert_eq!(msgs[0]["result"]["protocolVersion"], "2025-11-25");
    assert!(msgs[0].get("error").is_none());

    // 2) garbage line — JSON-RPC parse error, null id, never silently dropped.
    assert!(msgs[1]["id"].is_null(), "{}", msgs[1]);
    assert_eq!(msgs[1]["error"]["code"], -32700, "{}", msgs[1]);

    // 3) tools/list — THE invariant this whole shell exists for: answered
    // from the compiled-in static schema, with no GUI process anywhere in
    // this test. Exactly 2 read-only tools.
    assert_eq!(msgs[2]["id"], 2);
    let tools = msgs[2]["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 2, "{}", msgs[2]);
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"search"), "{names:?}");
    assert!(names.contains(&"vault_info"), "{names:?}");

    // 4) tools/call — the ONE method allowed to require the GUI. Unreachable
    // here, so it must degrade to `result.isError: true`, never a top-level
    // protocol `error` (an agent judges the whole tool dead on the latter).
    assert_eq!(msgs[3]["id"], 3);
    assert!(msgs[3].get("error").is_none(), "{}", msgs[3]);
    assert_eq!(msgs[3]["result"]["isError"], true, "{}", msgs[3]);
}

/// `tools/list` alone, isolated from every other concern above: the minimal
/// form of "note.md need not be running" that an MCP client actually relies
/// on at session start.
#[test]
fn tools_list_alone_returns_two_tools_with_no_gui() {
    let home = temp_home();
    let (code, replies, stderr) = run_mcp_session(
        &[r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#],
        &home,
    );
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(code, 0, "stderr was: {stderr}");
    assert_eq!(replies.len(), 1, "replies were: {replies:?}");
    let msg: serde_json::Value = serde_json::from_str(&replies[0]).unwrap();
    assert_eq!(msg["result"]["tools"].as_array().unwrap().len(), 2);
}

/// `mcp` is reached through the real CLI router, not called directly — this
/// is the part a unit test on `run_shim` alone could never catch (e.g. a
/// routing regression that sent `mcp` to `Route::Unknown` instead of
/// `Builtin::Mcp`, which would print an "unknown command" line to stderr and
/// exit 127 well before `run_shim` ever ran).
#[test]
fn mcp_is_reached_through_real_cli_routing() {
    let home = temp_home();
    let (code, replies, stderr) =
        run_mcp_session(&[r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#], &home);
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(code, 0, "stderr was: {stderr}");
    assert!(!stderr.contains("unknown command"), "stderr was: {stderr}");
    assert_eq!(replies.len(), 1);
}

/// A client that declares the `roots` capability gets asked for its roots
/// (a reverse `roots/list` request) before its first `tools/call` is
/// forwarded, and the round trip completes rather than hanging — this is the
/// end-to-end shape of the fix for the deadlock where `request_roots` used to
/// have no deadline of its own and could wait forever on a client that never
/// answered while it was itself waiting on us.
///
/// This test's "client" answers immediately: all three input lines are
/// written to the child's stdin up front (see `run_mcp_session`), including
/// the reply to the `roots/list` request the shim hasn't sent yet at write
/// time. That's fine — the shim reads its stdin sequentially through a single
/// pipe, so by the time it actually asks (mid-way through handling the
/// `tools/call`), the answer is already sitting there waiting to be read; no
/// real interactivity is required to prove the round trip doesn't hang. The
/// literal id `"notemd-roots"` is this shim's actual wire contract for the
/// reverse request (see `mcp::shim::request_roots`), not a guess.
///
/// There is no GUI reachable in this test, so the `tools/call` still
/// degrades to `result.isError`, same as every other test in this file —
/// this test is only about the roots round trip completing, not about roots
/// reaching a live GUI (that's `mcp::server`'s unit tests).
#[test]
fn roots_round_trip_completes_without_hanging_when_client_answers() {
    let home = temp_home();
    let (code, replies, stderr) = run_mcp_session(
        &[
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{"roots":{}}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"vault_info","arguments":{}}}"#,
            r#"{"jsonrpc":"2.0","id":"notemd-roots","result":{"roots":[{"uri":"file:///tmp/whatever"}]}}"#,
        ],
        &home,
    );
    let _ = std::fs::remove_dir_all(&home);

    assert_eq!(code, 0, "stderr was: {stderr}");
    // 3 lines out: the initialize reply, the shim's own outgoing roots/list
    // request (a request, not a reply to anything we sent), and the
    // tools/call reply once the round trip resolves.
    assert_eq!(replies.len(), 3, "replies were: {replies:?}");

    let msgs: Vec<serde_json::Value> =
        replies.iter().map(|l| serde_json::from_str(l).expect(l)).collect();

    assert_eq!(msgs[0]["id"], 1);
    assert!(msgs[0].get("error").is_none(), "{}", msgs[0]);

    assert_eq!(msgs[1]["method"], "roots/list");
    assert_eq!(msgs[1]["id"], "notemd-roots");

    assert_eq!(msgs[2]["id"], 2);
    assert!(msgs[2].get("error").is_none(), "{}", msgs[2]);
    assert_eq!(msgs[2]["result"]["isError"], true, "{}", msgs[2]);
}

/// stdout 纪律(2026-11-04 spec §3.3):`--cli mcp` 写到 stdout 的**每一行**都必须
/// 是 JSON-RPC —— Desktop 按行解析,混进一行诊断文本就会判这个 server 损坏。
/// 诊断(例如拉起 GUI 失败的警告)只能去 stderr。
#[test]
fn every_stdout_line_is_json() {
    let home = temp_home();
    std::fs::create_dir_all(&home).unwrap();
    let out = Command::new(binary_path())
        .args(["--cli", "mcp"])
        .env("HOME", &home)
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null())
        .output()
        .expect("run binary");
    let _ = std::fs::remove_dir_all(&home);
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        serde_json::from_str::<serde_json::Value>(line)
            .unwrap_or_else(|e| panic!("non-JSON stdout line {line:?}: {e}"));
    }
}

fn run_setup(args: &[&str], home: &PathBuf) -> (i32, String, String) {
    std::fs::create_dir_all(home).unwrap();
    let out = Command::new(binary_path())
        .arg("--cli")
        .args(args)
        .env("HOME", home)
        .env_remove("XDG_RUNTIME_DIR")
        .stdin(Stdio::null())
        .output()
        .expect("run binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

/// `mcp setup` 的输出就是 `setup::render` 的输出,路径是这个二进制自己的规范路径。
#[cfg(target_os = "macos")]
#[test]
fn mcp_setup_prints_exactly_the_rendered_instructions() {
    use notemd_lib::mcp::setup::{render, Lang};
    let bin = binary_path().canonicalize().unwrap();
    for (flag, lang) in [(None, Lang::En), (Some("en"), Lang::En), (Some("zh"), Lang::Zh)] {
        let home = temp_home();
        let mut args = vec!["mcp", "setup"];
        if let Some(l) = flag {
            args.extend(["--lang", l]);
        }
        let (code, stdout, stderr) = run_setup(&args, &home);
        let _ = std::fs::remove_dir_all(&home);
        assert_eq!(code, 0, "stderr was: {stderr}");
        assert_eq!(stdout, render(&bin, env!("CARGO_PKG_VERSION"), lang), "{args:?}");
        assert!(stderr.is_empty(), "setup must not print diagnostics (e.g. GUI launch): {stderr}");
    }
}

/// 设置里关了 MCP → 不生成,退出码 2,原因写 stderr。
#[cfg(target_os = "macos")]
#[test]
fn mcp_setup_refuses_when_mcp_is_disabled() {
    let home = temp_home();
    let config = home.join("Library/Application Support/net.notemd.app");
    std::fs::create_dir_all(&config).unwrap();
    std::fs::write(config.join("settings.json"), r#"{"mcpServer":{"enabled":false}}"#).unwrap();
    let (code, stdout, stderr) = run_setup(&["mcp", "setup"], &home);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "{stdout}");
    assert!(stderr.contains("turned off"), "{stderr}");
}

#[test]
fn mcp_setup_rejects_unknown_language() {
    let home = temp_home();
    let (code, stdout, _) = run_setup(&["mcp", "setup", "--lang", "fr"], &home);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "{stdout}");
}

/// 非 macOS:设置说明不生成(其他平台设置页给一行注册配置)。
#[cfg(not(target_os = "macos"))]
#[test]
fn mcp_setup_is_macos_only() {
    let home = temp_home();
    let (code, stdout, _) = run_setup(&["mcp", "setup"], &home);
    let _ = std::fs::remove_dir_all(&home);
    assert_eq!(code, 2);
    assert!(stdout.is_empty());
}
