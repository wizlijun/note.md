# ExLibris

Independent macOS app for managing an ebook library. Companion to mdeditor: shares the sotvault git-synced directory and is launched from mdeditor's tray menu.

## Architecture

See [`docs/superpowers/specs/2026-05-18-exlibris-ebook-manager-design.md`](../docs/superpowers/specs/2026-05-18-exlibris-ebook-manager-design.md).

## Development

```sh
pnpm install
pnpm --filter exlibris tauri:dev
```

## Build

```sh
pnpm build:exlibris   # builds per-arch dmgs
```

Artifacts: `src-tauri/target/{aarch64,x86_64}-apple-darwin/release/bundle/dmg/*.dmg`.

## Manual Smoke Test

1. First launch → onboarding banner. Pick sotvault / rawvault dirs; if calibre is installed at `/Applications/calibre.app`, it auto-detects.
2. Drop a small `.epub` into the drop zone → Pending list appears with the title.
3. Click "Import" → progress runs. Verify:
   - `<rawvault>/books/<YYYY>/<YYYYMM>/<Title>.epub` exists.
   - `<sotvault>/uncategorized/<Title>/book.md` and `meta.yml` exist.
4. Drop unsupported `.png` / `.zip` → red "Unsupported" row, cannot be selected.
5. Drop a large PDF (> 50 MB) → progress is visible per book; click Cancel All → in-progress book aborts, partial files cleaned up.
6. Drop the same book twice → second one shows "🔁 exists" and is unselected by default.
7. Settings → add a rule (`tag_contains: programming → tech`) → Save → Rebuild Sotvault → diff appears → Apply → book moves to `sotvault/tech/`.
8. Verify → orphan/missing/duplicate report.
9. mdeditor tray → "Open Books" → ExLibris launches.
