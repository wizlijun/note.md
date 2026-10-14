import { projectShareBrowserSource } from './scripts/project-share-browser.mjs'
import { controlledEnvDir } from './scripts/controlled-env.mjs'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { shareEditorAssets } from './scripts/share-editor-assets.mjs'

export default defineConfig({
  envDir: controlledEnvDir(),
  plugins: [projectShareBrowserSource(), svelte({ hot: false }), shareEditorAssets({ test: true })],
  resolve: {
    conditions: ['browser'],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'website/src/**/*.test.ts'],
    // Allow `?raw` imports of CSS files (e.g. src/styles/pdf.css?raw) to
    // resolve to their text contents instead of being stubbed by vitest's
    // default CSS-disable plugin.
    css: { include: [/\.css\?raw$/] },
  },
})
