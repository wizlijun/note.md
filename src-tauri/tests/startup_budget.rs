use mdeditor_lib::plugin_host;
use std::path::PathBuf;
use std::time::Instant;

/// Builds a temp dir containing only the perf_* fixture manifests.
/// Returns the temp dir path. The temp dir's parent is the system temp,
/// so the dir is automatically distinct per test run.
fn build_perf_plugins_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let src = manifest_dir.join("tests/fixtures");
    let target = std::env::temp_dir().join(format!(
        "mdeditor-plugin-perf-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
    ));
    std::fs::create_dir_all(&target).unwrap();
    for name in ["perf_a", "perf_b", "perf_c", "perf_d", "perf_e"] {
        let dst = target.join(name);
        std::fs::create_dir_all(&dst).unwrap();
        std::fs::copy(
            src.join(name).join("manifest.json"),
            dst.join("manifest.json"),
        ).unwrap();
    }
    target
}

#[test]
fn startup_within_budget() {
    let dir = build_perf_plugins_dir();
    let start = Instant::now();
    let count = plugin_host::init_from(&dir);
    let elapsed = start.elapsed();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(count, 5, "expected 5 plugins loaded");
    assert!(
        elapsed.as_millis() < 20,
        "budget violation: {} ms (limit 20)",
        elapsed.as_millis()
    );
}

#[test]
fn startup_does_not_touch_binaries() {
    // Each perf manifest declares binary "noexist" (file does not exist).
    // If `init_from` were calling .exists() / .stat() / opening the binary,
    // this would fail. Since the principle is "manifest only", it succeeds.
    let dir = build_perf_plugins_dir();
    let count = plugin_host::init_from(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(count, 5, "expected 5 plugins loaded despite missing binaries");
}
