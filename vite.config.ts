import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// `tauri ios dev` sets TAURI_DEV_HOST to the Mac's LAN IP so the iPhone /
// iPad can reach the Vite dev server over Wi-Fi. On desktop dev this stays
// undefined and Vite binds to localhost as usual.
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // When host is set (mobile dev), listen on all interfaces so the device
    // can connect. Otherwise leave default (localhost-only).
    host: host || false,
    hmr: host
      ? { protocol: 'ws', host, port: 1421 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: 'index.html',
        insights: 'insights.html',
        preview: 'preview.html',
        pluginMarket: 'plugin-market.html',
      },
    },
  },
  optimizeDeps: {
    entries: ['index.html', 'insights.html', 'preview.html', 'plugin-market.html'],
  },
})
