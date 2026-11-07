// Benchmark-only build transform. Keep real host IPC globals untouched while
// routing the production editor's Tauri API imports to the isolated adapter.
export function isolateTauriSource(code, id) {
  if (!id.replaceAll('\\', '/').includes('/@tauri-apps/')) return null
  const replacements = {
    __TAURI_INTERNALS__: '__SUMI_BENCH_INTERNALS__',
    __TAURI_EVENT_PLUGIN_INTERNALS__: '__SUMI_BENCH_EVENT_INTERNALS__',
    __TAURI_OS_PLUGIN_INTERNALS__: '__SUMI_BENCH_OS_INTERNALS__',
  }
  return code.replace(/\bwindow\.(__TAURI_INTERNALS__|__TAURI_EVENT_PLUGIN_INTERNALS__|__TAURI_OS_PLUGIN_INTERNALS__)\b/g,
    (_, name) => `window.${replacements[name]}`)
}

export function isolateTauri() {
  return { name: 'sumi-benchmark-isolated-tauri', enforce: 'pre', transform: isolateTauriSource }
}
