import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'node20',
    outDir: 'dist-cli',
    minify: false,
    lib: { entry: 'scripts/task-cli.ts', formats: ['es'], fileName: () => 'next-task-cli.mjs' },
    rollupOptions: { external: /^node:/ },
  },
})
