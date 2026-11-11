"""Execute the host's production appearance adapter with a controlled OS window.

This covers platform-gated behavior, Retina geometry, repeated fullscreen changes,
and preserving the user's base appearance. It does not create a real GUI window.
"""
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def function(source, name):
    start = source.index(f'fn {name}')
    opening = source.index('{', start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


FIXTURE = r'''
#![allow(dead_code, unused_variables, unused_mut)]
use std::{marker::PhantomData, cell::RefCell, collections::HashMap, sync::Mutex};
fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
    let mut future = Box::pin(future);
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match future.as_mut().poll(&mut context) {
        std::task::Poll::Ready(value) => value,
        _ => panic!("fixture unexpectedly waits on a real OS event"),
    }
}
struct AsyncMutex(Mutex<()>);
impl AsyncMutex { async fn lock(&self) -> std::sync::MutexGuard<'_, ()> { self.0.lock().unwrap() } }
#[derive(Clone)]
struct Surface { surface_id: String, generation: u64 }
struct Preferences { font_size: f64 }
struct Workspace {
    appearance_changes: AsyncMutex,
    surface_appearances: Mutex<HashMap<String, (Surface, Appearance)>>,
    preferences: Mutex<Preferences>,
}
fn workspace() -> Workspace {
    Workspace {
        appearance_changes: AsyncMutex(Mutex::new(())), preferences: Mutex::new(Preferences { font_size: 22.0 }),
        surface_appearances: Mutex::new(HashMap::from([("page".into(), (Surface { surface_id: "surface".into(), generation: 4 }, appearance()))])),
    }
}
fn current_ui_locale(_: &()) -> String { "en".into() }
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
trait Runtime {}
struct TestRuntime;
impl Runtime for TestRuntime {}
#[derive(Clone, Debug, PartialEq)]
struct Appearance { font_size: f64, line_height: f64, font_family: String, locale: String }
mod native {
    pub(super) type Appearance = super::Appearance;
    pub(super) enum SurfaceCommand { SetAppearance { appearance: Appearance } }
    pub(super) async fn command<R: super::Runtime>(window: &super::WebviewWindow<R>, _: String, _: u64, command: SurfaceCommand) -> super::Result<()> {
        let SurfaceCommand::SetAppearance { appearance } = command;
        window.applied.borrow_mut().push(appearance);
        if let Some(error) = window.next_error.borrow_mut().take() { return Err(error); }
        Ok(())
    }
}
struct Size { width: u32, height: u32 }
struct WebviewWindow<R: Runtime> {
    label: String, width: u32, height: u32, scale: f64, fullscreen: bool,
    runtime: PhantomData<R>, applied: RefCell<Vec<Appearance>>, next_error: RefCell<Option<String>>,
}
impl<R: Runtime> WebviewWindow<R> {
    fn app_handle(&self) -> &() { &() }
    fn label(&self) -> &str { &self.label }
    fn as_ref(&self) -> &Self { self }
    fn size(&self) -> Result<Size> { Ok(Size { width: self.width, height: self.height }) }
    fn scale_factor(&self) -> Result<f64> { Ok(self.scale) }
    fn is_fullscreen(&self) -> Result<bool> { Ok(self.fullscreen) }
}
fn is_plugin_window(label: &str) -> bool { label == "sumi" }
fn window(width: u32, height: u32, scale: f64) -> WebviewWindow<TestRuntime> {
    WebviewWindow { label: "sumi".into(), width, height, scale, fullscreen: true, runtime: PhantomData, applied: RefCell::new(Vec::new()), next_error: RefCell::new(None) }
}
fn appearance() -> Appearance {
    Appearance { font_size: 22.0, line_height: 1.6, font_family: "Sumi Registered Cascade".into(), locale: "en".into() }
}
#[test]
fn actual_platform_adapter_scales_fullscreen() {
    let original = appearance();
    let output = effective_appearance(&window(1920, 1200, 1.0), original.clone()).unwrap();
    assert_eq!(output.font_size, 27.5);
    assert_eq!(output.line_height, original.line_height);
    assert_eq!(output.font_family, original.font_family);
    assert_eq!(original.font_size, 22.0);
}
#[test]
fn retina_and_low_height_use_logical_viewport() {
    assert_eq!(effective_appearance(&window(3840, 2400, 2.0), appearance()).unwrap().font_size, 27.5);
    assert_eq!(effective_appearance(&window(1920, 900, 2.0), appearance()).unwrap().font_size, 22.0);
}
#[test]
fn ordinary_host_window_never_scales() {
    let mut window = window(3840, 2400, 1.0); window.label = "main".into();
    assert_eq!(effective_appearance(&window, appearance()).unwrap(), appearance());
}
#[test]
fn repeated_fullscreen_exit_restores_saved_size() {
    let mut window = window(1920, 1200, 1.0);
    let saved = appearance();
    for fullscreen in [true, true, false, true, false] {
        window.fullscreen = fullscreen;
        let output = effective_appearance(&window, saved.clone()).unwrap();
        assert_eq!(output.font_size, if fullscreen { 27.5 } else { 22.0 });
        assert_eq!(saved.font_size, 22.0);
    }
}

#[test]
fn refresh_uses_saved_size_and_prepared_font_without_drift() {
    let mut window = window(3840, 2400, 2.0); let workspace = workspace();
    for fullscreen in [true, true, false, true, false] {
        window.fullscreen = fullscreen;
        block_on(refresh_surface_font_size(&window, &workspace, "page", "surface", 4)).unwrap();
        let cache = workspace.surface_appearances.lock().unwrap();
        assert_eq!(cache["page"].1.font_size, if fullscreen { 27.5 } else { 22.0 });
        assert_eq!(cache["page"].1.font_family, appearance().font_family);
        assert_eq!(workspace.preferences.lock().unwrap().font_size, 22.0);
    }
    // The second identical fullscreen resize must not repaint the native editor.
    assert_eq!(window.applied.borrow().len(), 4);
}
#[test]
fn composition_defers_font_until_success_and_stale_surface_is_ignored() {
    let window = window(1920, 1200, 1.0); let workspace = workspace();
    block_on(refresh_surface_font_size(&window, &workspace, "page", "stale", 4)).unwrap();
    block_on(refresh_surface_font_size(&window, &workspace, "page", "surface", 3)).unwrap();
    assert!(window.applied.borrow().is_empty());
    *window.next_error.borrow_mut() = Some("composition active".into());
    block_on(refresh_surface_font_size(&window, &workspace, "page", "surface", 4)).unwrap();
    assert_eq!(workspace.surface_appearances.lock().unwrap()["page"].1.font_size, 22.0);
    block_on(refresh_surface_font_size(&window, &workspace, "page", "surface", 4)).unwrap();
    assert_eq!(workspace.surface_appearances.lock().unwrap()["page"].1.font_size, 27.5);
    assert_eq!(workspace.preferences.lock().unwrap().font_size, 22.0);
}
'''


class FullscreenAppearanceTests(unittest.TestCase):
    def test_production_adapter_on_current_platform(self):
        source = (ROOT / 'src-tauri/src/sumi/mod.rs').read_text()
        rust = FIXTURE + '\n' + function(source, 'fullscreen_font_size') + '\n' + function(source, 'effective_appearance') + '\n' + function(source, 'refresh_surface_font_size').replace('fn refresh_surface_font_size', 'async fn refresh_surface_font_size', 1)
        with tempfile.TemporaryDirectory(prefix='sumi-fullscreen-') as directory:
            path = Path(directory)
            (path / 'test.rs').write_text(rust)
            subprocess.run(['rustc', '--edition=2021', '--test', str(path / 'test.rs'), '-o', str(path / 'test')], check=True)
            result = subprocess.run([str(path / 'test'), '--nocapture'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            print(result.stdout, end="")


if __name__ == '__main__':
    unittest.main()
