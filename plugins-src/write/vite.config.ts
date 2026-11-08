import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  publicDir: 'resources',
  build: { target: 'safari15', outDir: 'dist', emptyOutDir: true },
})
