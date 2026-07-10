//! Regression test: CLI mode dispatch must be fast.
//!
//! Asserts that `notemd help` returns under 500 ms on developer hardware
//! (release builds) or under 2500 ms in debug. The release budget reflects
//! the real-world goal — a user-perceptible `notemd help` invocation. Debug
//! builds carry significant extra overhead (no opt, large dylib graph,
//! cargo test harness fork) so we allow more headroom there while still
//! catching catastrophic regressions (e.g., the dispatch path accidentally
//! initializing Tauri / webview / plugin host).

use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

#[cfg(debug_assertions)]
const BUDGET_MS: u128 = 2500;
#[cfg(not(debug_assertions))]
const BUDGET_MS: u128 = 500;

#[test]
fn cli_help_returns_quickly() {
    use std::os::unix::process::CommandExt;
    let bin = PathBuf::from(env!("CARGO_BIN_EXE_mdeditor"));
    let dir = std::env::temp_dir().join(format!(
        "notemd-timing-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let plugin = dir.join("p");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(
        plugin.join("manifest.json"),
        r#"{"id":"p","name":"P","version":"0.1.0","binary":"bin","host_capabilities":[]}"#,
    ).unwrap();

    // Warm up: first invocation pays cold dyld / linker / codesign cost.
    // We're measuring dispatch overhead, not page-fault-in-the-fs cost.
    {
        let mut warm = Command::new(&bin);
        warm.arg0("notemd");
        warm.args(["--plugin-dir", dir.to_str().unwrap(), "help"]);
        warm.env("HOME", std::env::temp_dir().to_str().unwrap());
        let _ = warm.output();
    }

    let start = Instant::now();
    let mut cmd = Command::new(bin);
    cmd.arg0("notemd");
    cmd.args(["--plugin-dir", dir.to_str().unwrap(), "help"]);
    cmd.env("HOME", std::env::temp_dir().to_str().unwrap());
    let output = cmd.output().expect("spawn");
    let elapsed = start.elapsed();

    let _ = std::fs::remove_dir_all(&dir);
    assert!(output.status.success(), "help should exit 0, got {:?}", output.status);
    assert!(
        elapsed.as_millis() < BUDGET_MS,
        "notemd help took {} ms (budget {})",
        elapsed.as_millis(),
        BUDGET_MS,
    );
}
