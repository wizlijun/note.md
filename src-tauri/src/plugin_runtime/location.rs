//! Host-side location for plugins via `host.location.get` (capability `location`).
//!
//! IMPLEMENTATION: we shell out to the bundled `notemd-location` sidecar (a
//! faithful port of fulldecent/CoreLocationCLI). See `location-helper/`. The
//! sidecar runs a CLEAN main run loop doing nothing but CoreLocation, so the
//! authorization prompt and delegate callbacks are reliably delivered — unlike
//! the earlier in-process attempts that ran CLLocationManager on Tauri/tao's
//! event loop and never got past NotDetermined. macOS attributes the sidecar's
//! request to the responsible parent (the signed, notarized note.md.app carrying
//! NSLocationUsageDescription), so the prompt reads "note.md wants to use your
//! location". The sidecar prints one JSON object and exits; we parse and return.
//!
//! The sidecar is bundled via Tauri `externalBin` and lands next to the main
//! executable inside `note.md.app/Contents/MacOS/notemd-location`.

use serde_json::Value;

/// Blocking one-shot location read → `{country, province, city, poi, latitude, longitude}`.
/// Spawns the `notemd-location` sidecar and parses its JSON. Blocks up to the
/// sidecar's own timeout (~20s including the authorization prompt + first fix +
/// reverse geocode).
#[cfg(target_os = "macos")]
pub fn fetch_once<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<Value, String> {
    let helper = helper_path()?;
    let output = std::process::Command::new(&helper)
        .output()
        .map_err(|e| format!("failed to launch location helper {}: {e}", helper.display()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = stderr.trim();
        // The sidecar's stderr already carries the actionable reason (denied /
        // timed out / geocode failed); surface it verbatim.
        return Err(if msg.is_empty() {
            format!("location helper exited with {}", output.status)
        } else {
            msg.to_string()
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return Err("location helper produced no result".into());
    }
    serde_json::from_str(line).map_err(|e| format!("bad location helper output: {e}"))
}

#[cfg(not(target_os = "macos"))]
pub fn fetch_once<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> Result<Value, String> {
    Err("location is only supported on macOS".into())
}

/// Resolve the bundled `notemd-location` sidecar. Tauri strips the target-triple
/// suffix and places it beside the main binary in `Contents/MacOS/`.
#[cfg(target_os = "macos")]
fn helper_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "executable has no parent directory".to_string())?;
    let helper = dir.join("notemd-location");
    if helper.exists() {
        return Ok(helper);
    }
    // Dev fallback: the arch-suffixed staged binary under src-tauri/binaries
    // (present when running an unbundled dev build).
    let triple = current_triple();
    let dev = dir.join(format!("notemd-location-{triple}"));
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!(
        "location helper not found next to {} (is the notemd-location sidecar bundled?)",
        exe.display()
    ))
}

#[cfg(target_os = "macos")]
fn current_triple() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    }
}

/// No-op: with the sidecar design the authorization prompt appears the first
/// time the sidecar runs (first "Save Location Now" or the first 30-min round),
/// attributed to note.md.app. Kept for call-site compatibility.
pub fn init_at_startup<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}
