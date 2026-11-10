import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { projectShareBrowserSource } from '../../scripts/project-share-browser.mjs'
import { shareEditorAssets } from '../../scripts/share-editor-assets.mjs'
export default defineConfig({
  root: process.cwd(), envDir: 'tasks/linux-updater-webkit/empty-env',
  cacheDir: 'tasks/linux-updater-webkit/vite-cache',
  plugins: [projectShareBrowserSource(), svelte({ hot: false }), shareEditorAssets({ test: true })],
  resolve: { conditions: ['browser'] },
  optimizeDeps: { entries: ['tasks/linux-updater-webkit/index.html'] },
  server: { host: '127.0.0.1', port: 5188, strictPort: true, watch: { ignored: ['**/tasks/**', '**/src-tauri/**'] } },
})
