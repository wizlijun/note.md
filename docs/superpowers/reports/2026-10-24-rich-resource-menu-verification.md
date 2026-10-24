# Rich resource context menus — 2026-10-24

## Change

Desktop RichEditor now opens the shared menu on images, attachment links and HTML media. Local resources offer Copy File Name, Copy Absolute Path and Save File As; decoded images also offer Copy Image. Remote resources offer Copy Link instead of an invented local path. Read-only views retain these export operations. English, Chinese, Japanese and German labels are included.

Targets use original ProseMirror image attributes or HTML NodeView metadata, never the renderer's temporary blob URL. Local lookup reuses `localResourceCandidates` with the current document directory and Vault root, preserving encoded filenames and the Vault/filesystem fallback order. Path copying uses existence checks rather than reading entire attachments. Save As preserves original bytes, cancellation performs no file read/write, and failures appear through the existing error UI. Bitmap copying uses the native clipboard and native HTTP fallback for cross-origin images.

The image sizing toolbar no longer intercepts later right-clicks on the image. Menus retain global `menu-panel`/`menu-row` styling. Every host window entry installs a capture-phase default-menu guard; the plugin bridge installs the same default prevention for plugin windows and iframe documents. Custom contextmenu handlers still receive events.

## Verification

- 12 test files / 141 tests passed: context menu models/actions/guards, actual desktop RichEditor mounting, file image editing/history, shared file context menus, local resource paths and Tauri media resolution.
- Resource tests cover Chinese/spaces/percent escapes/Windows/file URLs, fallback lookup, original binary bytes, clipboard separation, missing files, write/HTTP failures, cancellation, embedded and remote URLs, HTML media and broken images.
- `svelte-check --tsconfig ./tsconfig.json`: 0 errors, 31 existing warnings.
- `npm run build`: passed, including share purity, production Vite build and editor/share artifact gates.
- Chrome 155.0.8059.85 mounted the real RichEditor with an isolated native IPC fixture. Image and attachment menus, path/name actions, original-byte saves, cancel, actual canvas-to-PNG clipboard payload, read-only export, Escape dismissal and blank-space default prevention passed without page errors. The Markdown remained byte-for-byte unchanged.
- Light/dark menu hover computed to `rgb(0, 117, 255)` with white text; screenshots inspected. At 390px width, the bottom-right menu remained inside the viewport. Left-click image → sizing toolbar → right-click image correctly opened the resource menu and closed the toolbar.
- Plugin test extracts and executes the production Rust bridge's JS template in an iframe document, checking duplicate initialization, default prevention and preservation of custom handlers.
- Independent review identified and resolved the toolbar overlay issue and avoided whole-file reads for path copying. `git diff --check` passed.

Local repeatable browser fixture, screenshots and detailed logs: `tasks/rich-resource-menu-20261024/` (ignored task artifacts).

## Boundaries

Native clipboard, save dialog, file read/write and HTTP boundaries were simulated in frontend verification; no OS clipboard or save-dialog acceptance is claimed. Rust was not rebuilt and native plugin WebViews were not launched for this one-line JS template addition. Public share pages retain their browser-capability menu behavior and do not import desktop file APIs. No installation, release or push was performed. Parallel Health Sync edits and pre-existing untracked files were excluded from this change.
