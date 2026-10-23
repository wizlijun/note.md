//! Real pipes and temporary executables; no Roam connection or vault writes.
use notemd_roam_import::{roam_cli, roam_page};
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::{Duration, Instant};

fn fake_roam(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    let exe = dir.join("roam");
    fs::write(&exe, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
    // Login-shell discovery is setup, not part of the command's timeout.
    notemd_roam_import::discover::cached_login_shell_path();
    exe
}

fn run_fake_roam(
    exe: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<String, String> {
    // Explicitly interpret the fixture: first execution of a newly created
    // executable script on macOS can stall before its first statement. That
    // startup delay also occurs with plain subprocess.Popen, independently of
    // our pipe handling, and can consume the whole timeout before recording
    // the PID. Use the existing system executable while preserving the fake
    // command, real pipes, production CLI wrapper, and original deadline.
    let mut shell_args = vec![exe.to_str().unwrap()];
    shell_args.extend_from_slice(args);
    roam_cli::run(std::path::Path::new("/bin/sh"), &shell_args, timeout)
}

#[test]
fn parses_large_page_while_draining_both_pipes() {
    let dir = tempfile::tempdir().unwrap();
    let body = "x".repeat(1024 * 1024 + 1);
    let payload = serde_json::json!([[{
        "title": "April 30th, 2026", "uid": "04-30-2026",
        "children": [{"uid": "large-block", "string": body, "order": 0}]
    }]])
    .to_string();
    fs::write(dir.path().join("page.json"), &payload).unwrap();
    fs::write(
        dir.path().join("stderr.txt"),
        "diagnostic\n".repeat(120_000),
    )
    .unwrap();
    // stderr must drain before stdout starts, and again after stdout fills.
    let exe = fake_roam(dir.path(),
        "cd -- \"$(dirname -- \"$0\")\"\n/bin/cat stderr.txt >&2\n/bin/cat page.json\n/bin/cat stderr.txt >&2");
    let started = Instant::now();
    let out = run_fake_roam(
        &exe,
        &[
            "datalog-query",
            "--query",
            &roam_cli::day_query("04-30-2026"),
        ],
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(out == payload, "stdout was truncated or changed");
    let page = roam_page::parse_day_result(&serde_json::from_str(&out).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(page.title, "April 30th, 2026");
    assert!(page.children[0].string == body);
}

#[test]
fn timeout_kills_and_reaps_fake_roam() {
    let dir = tempfile::tempdir().unwrap();
    let exe = fake_roam(dir.path(), "echo $$ > \"$0.pid\"\nexec /bin/sleep 10");
    let started = Instant::now();
    let err = run_fake_roam(&exe, &[], Duration::from_secs(1)).unwrap_err();
    assert!(err.contains("timed out after 1s"), "{err}");
    assert!(err.contains("/bin/sh"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(3));
    let pid = fs::read_to_string(dir.path().join("roam.pid")).unwrap();
    // ps includes zombies: absence establishes both termination and reaping.
    let output = Command::new("/bin/ps")
        .args(["-p", pid.trim(), "-o", "pid="])
        .output()
        .unwrap();
    assert!(
        !output.status.success(),
        "child still exists: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(output.stdout.is_empty());
}

#[test]
fn preserves_large_stderr_on_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let diagnostic = format!("{}final error", "diagnostic\n".repeat(120_000));
    fs::write(dir.path().join("stderr.txt"), &diagnostic).unwrap();
    let exe = fake_roam(
        dir.path(),
        "cd -- \"$(dirname -- \"$0\")\"\n/bin/cat stderr.txt >&2\nexit 7",
    );
    let err = run_fake_roam(&exe, &[], Duration::from_secs(2)).unwrap_err();
    assert!(
        err == diagnostic,
        "stderr was truncated or replaced: {} bytes",
        err.len()
    );
}

#[test]
fn pipe_held_open_after_child_exit_is_still_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let exe = fake_roam(dir.path(), "/bin/sleep 10 &\necho $! > \"$0.pid\"\nexit 0");
    let started = Instant::now();
    let result = run_fake_roam(&exe, &[], Duration::from_secs(1));
    let elapsed = started.elapsed();
    // Clean up the deliberately orphaned fixture before making assertions.
    let pid = fs::read_to_string(dir.path().join("roam.pid")).unwrap();
    Command::new("/bin/kill")
        .args(["-KILL", pid.trim()])
        .status()
        .unwrap();
    let err = result.unwrap_err();
    assert!(err.contains("timed out after 1s"), "{err}");
    assert!(elapsed < Duration::from_secs(3));
}
