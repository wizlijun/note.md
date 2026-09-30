import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  plugins: [svelte()],
  base: './',
  worker: { format: 'es' },
  build: { target: 'safari15', outDir: 'dist', sourcemap: false },
})
