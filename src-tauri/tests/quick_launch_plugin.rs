//! Production Quick Launch manifest and built UI integration.
//! Build the actual bundle first: `pnpm --filter quick-launch build`.
//! All installation state is temporary; no user configuration or command runs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use notemd_lib::plugin_runtime::{self, discovery, protocol, quick_launch, state};
use plugin_protocol::ManifestV2;

const HOST: &str = "6.1030.1";
const ID: &str = quick_launch::PLUGIN_ID;
type Installed = BTreeMap<String, (ManifestV2, PathBuf)>;

fn source() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins-src/quick-launch")
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

fn install_fixture(root: &Path, with_bundle: bool) -> state::InstallState {
    let source = source();
    let current = root.join(ID).join("current");
    std::fs::create_dir_all(&current).unwrap();
    if with_bundle {
        assert!(
            source.join("dist/index.html").is_file(),
            "Build first: pnpm --filter quick-launch build"
        );
        copy_tree(&source.join("dist"), &current.join("ui"));
    }
    std::fs::copy(
        source.join("manifest.v2.json"),
        current.join("manifest.json"),
    )
    .unwrap();
    let manifest: ManifestV2 =
        serde_json::from_slice(&std::fs::read(current.join("manifest.json")).unwrap()).unwrap();
    let mut state = state::InstallState::default();
    state.installed.insert(
        ID.into(),
        state::InstalledPlugin {
            version: manifest.version,
            enabled: true,
        },
    );
    state::save(root, &state).unwrap();
    state
}

// Only the lifecycle test touches STATE; restore it even if an assertion panics.
struct RestoreState(Installed);
impl Drop for RestoreState {
    fn drop(&mut self) {
        plugin_runtime::STATE.write().unwrap().plugins = std::mem::take(&mut self.0);
    }
}

#[test]
fn production_manifest_discovery_enforces_host_and_enablement_lifecycle() {
    let root = tempfile::tempdir().unwrap();
    let mut state = install_fixture(root.path(), false);
    let _restore = RestoreState(std::mem::take(
        &mut plugin_runtime::STATE.write().unwrap().plugins,
    ));

    // The previous public host must not offer a plugin whose host RPC is absent.
    let old = discovery::scan_root(root.path(), "6.1028.1");
    assert!(old.is_empty());
    plugin_runtime::STATE.write().unwrap().plugins = old;
    assert!(!quick_launch::enabled());

    let installed = discovery::scan_root(root.path(), HOST);
    let (manifest, _) = installed
        .get(ID)
        .expect("production manifest must validate");
    assert!(manifest.binary.is_empty());
    assert!(manifest.contributes.settings.is_none());
    assert_eq!(manifest.contributes.menus[0]["submenu"], "experience");
    let menu_command = manifest.contributes.menus[0]["command"].as_str().unwrap();
    let window = manifest
        .contributes
        .windows
        .iter()
        .find(|window| window.open_command.as_deref() == Some(menu_command))
        .expect("plugin menu must open its own configuration window");
    assert_eq!(window.id, "main");
    assert_eq!(window.entry, "index.html");
    plugin_runtime::STATE.write().unwrap().plugins = installed;
    assert!(quick_launch::enabled());

    state.installed.get_mut(ID).unwrap().enabled = false;
    state::save(root.path(), &state).unwrap();
    plugin_runtime::STATE.write().unwrap().plugins = discovery::scan_root(root.path(), HOST);
    assert!(
        !quick_launch::enabled(),
        "disabled plugin must not retain launch access"
    );

    state.installed.get_mut(ID).unwrap().enabled = true;
    state::save(root.path(), &state).unwrap();
    plugin_runtime::STATE.write().unwrap().plugins = discovery::scan_root(root.path(), HOST);
    assert!(quick_launch::enabled());
    state.installed.remove(ID);
    state::save(root.path(), &state).unwrap();
    plugin_runtime::STATE.write().unwrap().plugins = discovery::scan_root(root.path(), HOST);
    assert!(
        !quick_launch::enabled(),
        "uninstalled plugin must not retain launch access"
    );
}

struct InstalledView(Installed);
impl protocol::PluginView for InstalledView {
    fn lookup(&self, plugin_id: &str) -> Option<(PathBuf, Vec<String>)> {
        let (manifest, directory) = self.0.get(plugin_id)?;
        Some((
            directory.join(manifest.ui.as_ref()?),
            manifest.capabilities.clone(),
        ))
    }
}

fn get(view: &InstalledView, path: &str) -> tauri::http::Response<Vec<u8>> {
    match protocol::handle_parsed(view, "GET", ID, path, None, "zh", "default") {
        protocol::Routed::Response(response) => response,
        _ => panic!("plugin asset must be served directly"),
    }
}

#[test]
#[ignore = "requires pnpm --filter quick-launch build; run with --include-ignored"]
fn production_bundle_is_served_with_the_real_bridge_before_its_module() {
    let root = tempfile::tempdir().unwrap();
    install_fixture(root.path(), true);
    let view = InstalledView(discovery::scan_root(root.path(), HOST));
    let index = get(&view, "/index.html");
    assert_eq!(index.status(), 200);
    assert_eq!(
        index.headers()["content-security-policy"],
        protocol::csp_header(ID)
    );
    let html = String::from_utf8(index.into_body()).unwrap();
    let bridge = html.find("src=\"/__notemd_bridge__.js\"").unwrap();
    assert!(bridge < html.find("type=\"module\"").unwrap());
    assert!(
        !html.contains("/src/main.ts"),
        "must serve built assets, not the dev entry"
    );

    let mut asset_count = 0;
    for attribute in ["src=\"./", "href=\"./"] {
        for reference in html.split(attribute).skip(1) {
            let relative = reference.split('"').next().unwrap();
            let response = get(&view, &format!("/{relative}"));
            assert_eq!(
                response.status(),
                200,
                "missing production asset {relative}"
            );
            assert!(!response.body().is_empty());
            asset_count += 1;
        }
    }
    assert!(
        asset_count >= 2,
        "production JS and CSS must both be packaged"
    );
    let bridge = get(&view, "/__notemd_bridge__.js");
    assert_eq!(bridge.status(), 200);
    let script = String::from_utf8(bridge.into_body()).unwrap();
    assert!(script.contains("window.notemd = Object.freeze"));
    assert!(script.contains(ID));
    assert!(script.contains("params: params ?? null"));

    match protocol::handle_parsed(
        &view,
        "POST",
        ID,
        "/__rpc__",
        Some("plugin://notemd.quick-launch"),
        "zh",
        "default",
    ) {
        protocol::Routed::Rpc(id, capabilities) => {
            assert_eq!(id, ID);
            assert!(capabilities
                .iter()
                .any(|capability| capability == "quick-launch"));
        }
        _ => panic!("authenticated plugin request must reach host RPC"),
    }
    match protocol::handle_parsed(
        &view,
        "POST",
        ID,
        "/__rpc__",
        Some("plugin://other.plugin"),
        "zh",
        "default",
    ) {
        protocol::Routed::Response(response) => assert_eq!(response.status(), 403),
        _ => panic!("foreign origin must not reach launch RPC"),
    }
}
