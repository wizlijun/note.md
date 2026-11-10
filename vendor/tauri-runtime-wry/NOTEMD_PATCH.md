# note.md Tauri runtime compatibility patches

Upstream: `tauri-runtime-wry` **2.11.1**, published at
https://static.crates.io/crates/tauri-runtime-wry/tauri-runtime-wry-2.11.1.crate

Published archive SHA-256: `a3989df2ae1c476404fe0a2e8ffc4cfbde97e51efd613c2bb5355fbc9ab52cf0`.

Upstream VCS metadata:
```json
{
  "git": {
    "sha1": "e5ae5b93cdd310045191cc0526f253140ad64b87"
  },
  "path_in_vcs": "crates/tauri-runtime-wry"
}
```

The source, build script, normalized Cargo manifest and original MIT / Apache-2.0
licenses are copied unchanged except for the fixes below in
`src/undecorated_resizing.rs` and `src/lib.rs`.

## GTK overlay window lookup

The button-press and touch handlers now resolve
`webview.toplevel()` and safely downcast to `gtk::Window`, instead of assuming
`webview.parent().parent()` is a window and unwrapping the cast.

The native editor inserts a GtkOverlay above the existing Wry GtkBox, preserving
its menu and WebView ownership. The fixed-depth cast panicked on ordinary WebView
left-clicks and aborted across the GTK callback boundary. Both handlers retain
all original decoration, resize, hit-testing and propagation behavior. Other
platform implementations are unchanged. An unattached WebView simply skips
window resizing.

## Thread-safe context ownership

`Context<T>` derives `Clone` and is included in handles that are cloned by worker
threads. Upstream stores `DispatcherMainThreadContext<T>` by value; its derived
clone reaches Tao's `EventLoopWindowTarget`, including non-atomic `Rc` owners on
Linux. The `unsafe Send` / `Sync` declarations on the wrapper do not make those
reference-count operations thread-safe. The investigated host core aborted in
`Rc::clone` with a zero strong count on the main thread, consistent with this
cross-thread ownership corruption; the nested clone path is also directly
visible in the runtime and Tao sources. Local evidence is retained in
`tasks/omarchy-build/sumi-host-gui/core-info.log` and `process.log` (repository
root-relative paths; these local crash artifacts are not distributed).

On Linux, `Context.main_thread` now holds an
`Arc<DispatcherMainThreadContext<T>>`, created once on the main thread. Other
platforms retain the upstream field type and by-value clone behavior; the shared
initializer uses `Into` to select Arc wrapping on Linux and identity conversion
elsewhere. While the runtime retains its owning Arc, cloning or
dropping a context handle changes the atomic Arc count instead of cloning or
dropping the nested Tao Rc values. The existing
main-thread checks in `run_threaded` and `send_message`, and the event-loop code
that accesses the inner state, remain unchanged. This is an ownership fix; it
does not authorize background access to GTK or assert that unrelated runtime
APIs are thread-safe. Both patches change Linux behavior only.

Local regression evidence for the Linux ownership change:
`tasks/omarchy-build/sumi-probe-run20-arc-breathing/clone-stress.json` records all
8 worker threads joined, 160,000 iterations / 320,000 explicit AppHandle and
WebviewWindow clone/drop operations, and 26 main-thread snapshot IPC responses
while the workers ran. The real runtime remained alive for the stress phase and
then completed the probe's menu, WebView controls and normal Quit flow.

Both `src-tauri` and `tauri-plugin-native-editor` use this same path patch.
When upgrading Tauri, compare both fixes with upstream, repeat the real Wayland
WebView click / touch callback, menu and background handle clone/drop stress
probes, and remove the patches only when upstream provides equivalent safe
window lookup and context ownership. Stress results provide regression evidence,
not a proof covering all possible thread schedules or shutdown races. In
particular, this patch does not establish that dropping external handles on a
worker after `run_return` / runtime destruction is safe; final inner-state
destruction remains a separate lifecycle concern.
