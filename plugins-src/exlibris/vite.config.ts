import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'node:path'

// Standalone plugin UI bundle. Served by the host under `plugin://<id>/…`, so
// asset URLs MUST be relative (`base: './'`) — an absolute `/assets/…` would
// break the traversal guard's entry-relative model. The build output `dist/`
// is copied verbatim into the installed plugin's `ui/` directory (see
// scripts/dev-install-plugin.sh).
//
// The Rust backend crate lives in `backend/` — Vite only bundles `src/` + the
// root `index.html`; the tsconfig `exclude` keeps svelte-check off `backend/`.
export default defineConfig({
  plugins: [svelte()],
  base: './',
  resolve: {
    alias: { $lib: path.resolve(__dirname, 'src/lib') },
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { index: 'index.html' },
    },
  },
})
