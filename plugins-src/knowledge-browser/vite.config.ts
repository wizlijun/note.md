import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { cpSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

function copyKnowledgeContracts() {
  return {
    name: 'copy-knowledge-contracts',
    closeBundle() {
      const destination = resolve('dist/references')
      mkdirSync(destination, { recursive: true })
      for (const name of ['relationship-extraction.schema.json', 'relation-types.json', 'provenance.json']) {
        cpSync(resolve('references', name), resolve(destination, name))
      }
    },
  }
}

export default defineConfig({
  plugins: [svelte(), copyKnowledgeContracts()],
  base: './',
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: { browser: 'browser.html', viewer: 'viewer.html' },
    },
  },
})
