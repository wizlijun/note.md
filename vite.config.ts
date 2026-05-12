import { defineConfig, type Plugin } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import path from 'path'

function mermaidMiniIconsShim(): Plugin {
  const shimPath = path.resolve(__dirname, 'src/lib/mermaid-canvas/icons-shim.ts')
  return {
    name: 'mermaid-mini-icons-shim',
    resolveId(source, importer) {
      if (source === './icons' && importer?.includes('mermaid-mini/dist/components')) {
        return shimPath
      }
    },
  }
}

export default defineConfig({
  plugins: [mermaidMiniIconsShim(), svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  optimizeDeps: {
    exclude: ['mermaid-mini'],
  },
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
  },
})
