//! End-to-end test for built-in CLI subcommands.
//!
//! Spawns the real `mdeditor` binary with argv[0] forced to "notemd" so the
//! CLI mode path triggers. Asserts stdout / stderr / exit code for the
//! happy paths. Plugin discovery uses --plugin-dir to point at fixtures.

use std::path::PathBuf;
use std::process::Command;

fn binary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mdeditor"))
}

/// Build a temp dir with a single fake plugin manifest declaring a CLI subcommand.
fn temp_plugins_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "notemd-cli-int-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    let plugin = dir.join("fakeplug");
    std::fs::create_dir_all(&plugin).unwrap();
    std::fs::write(plugin.join("manifest.json"), r#"{
      "id": "fakeplug",
      "name": "FakePlug",
      "version": "0.1.0",
      "binary": "bin",
      "host_capabilities": [],
      "cli": [{
        "subcommand": "fake",
        "aliases": ["-f"],
        "command": "noop",
        "summary": "Just a fake plugin for testing"
      }]
    }"#).unwrap();
    dir
}

fn run_cli(args: &[&str], plugins_dir: &PathBuf) -> (i32, String, String) {
    use std::os::unix::process::CommandExt;
    let mut cmd = Command::new(binary_path());
    cmd.arg0("notemd");          // force CLI mode via argv[0] basename
    cmd.args(["--plugin-dir", plugins_dir.to_str().unwrap()]);
    cmd.args(args);
    cmd.env_remove("HOME");
    cmd.env("HOME", std::env::temp_dir().to_str().unwrap());
    let out = cmd.output().expect("spawn binary");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

#[test]
fn help_lists_fake_plugin_command() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["help"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("PLUGIN COMMANDS:"), "stdout was: {stdout}");
    assert!(stdout.contains("fake"));
    assert!(stdout.contains("[FakePlug]"));
}

#[test]
fn version_prints_and_exits_zero() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["version"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("notemd"));
    assert!(stdout.contains("plugin API v1"));
}

#[test]
fn plugin_list_includes_fakeplug() {
    let dir = temp_plugins_dir();
    let (code, stdout, _) = run_cli(&["plugin", "list"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 0);
    assert!(stdout.contains("fakeplug"));
}

#[test]
fn unknown_subcommand_exits_127() {
    let dir = temp_plugins_dir();
    let (code, _, stderr) = run_cli(&["nope"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(code, 127);
    assert!(stderr.contains("unknown command"));
}

#[test]
fn legacy_mdedit_argv0_still_enters_cli_mode() {
    // Pre-rename `mdedit` symlinks must keep working after the note.md rename.
    use std::os::unix::process::CommandExt;
    let dir = temp_plugins_dir();
    let mut cmd = Command::new(binary_path());
    cmd.arg0("mdedit");
    cmd.args(["--plugin-dir", dir.to_str().unwrap(), "version"]);
    cmd.env("HOME", std::env::temp_dir().to_str().unwrap());
    let out = cmd.output().expect("spawn binary");
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(out.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&out.stdout).contains("notemd"));
}

#[test]
fn alias_routes_to_plugin_path_not_unknown() {
    let dir = temp_plugins_dir();
    let (code, _, _) = run_cli(&["-f", "anything.md"], &dir);
    let _ = std::fs::remove_dir_all(&dir);
    // The runner stub returns 1; the important thing is it's NOT 127 (unknown)
    // since that would mean the alias didn't resolve.
    assert_ne!(code, 127);
}
