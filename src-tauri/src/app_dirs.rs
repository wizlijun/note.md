//! Bundle-identifier constant. note.md ships as a fresh product: it stores
//! its data under `~/Library/Application Support/net.notemd.app` and does not
//! migrate any pre-rename `com.laobu.mdeditor` directory.

#[cfg(all(feature = "sumi-acceptance", not(debug_assertions)))]
compile_error!("sumi-acceptance is for isolated debug verification, never a release build");

#[cfg(feature = "sumi-acceptance")]
pub const BUNDLE_ID: &str = "net.notemd.sumi.acceptance";
#[cfg(not(feature = "sumi-acceptance"))]
pub const BUNDLE_ID: &str = "net.notemd.app";

/// Acceptance builds must fail before any runtime reads a production config or
/// starts background work. The fixture is created by the checked-in task script.
#[cfg(feature = "sumi-acceptance")]
pub fn validate_acceptance<R:tauri::Runtime>(app:&tauri::AppHandle<R>)->Result<(),Box<dyn std::error::Error>> {
    use tauri::Manager;
    if app.config().identifier!=BUNDLE_ID {return Err("acceptance bundle identifier mismatch".into())}
    let config=app.path().app_config_dir()?;
    if config.file_name().and_then(|s|s.to_str())!=Some(BUNDLE_ID){return Err("acceptance config directory mismatch".into())}
    let shared=crate::shared_config::read(&config.join("shared.json"))?;
    let expected=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("missing repository")?.join("tasks/sumi-native/host-acceptance/vault").canonicalize()?;
    if shared.sotvault.as_deref()!=expected.to_str(){return Err("acceptance Vault is not the isolated fixture".into())}
    if expected.join(".git").exists() || std::fs::read_to_string(expected.join(".sumi-acceptance-vault"))? != "sumi-acceptance-only\n" {return Err("acceptance Vault must be an unversioned fixture".into())}
    let settings:serde_json::Value=serde_json::from_slice(&std::fs::read(config.join("settings.json"))?)?;
    if crate::mcp::gate::enabled_from_value(&settings){return Err("acceptance MCP must be disabled".into())}
    Ok(())
}
