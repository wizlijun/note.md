import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
})
