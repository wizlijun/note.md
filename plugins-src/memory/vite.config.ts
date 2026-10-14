import { controlledEnvDir } from '../../scripts/controlled-env.mjs'
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  envDir: controlledEnvDir(),
  plugins: [svelte()],
  base: './',
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: 'index.html' } },
  },
})
