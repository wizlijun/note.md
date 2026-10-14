import { controlledEnvDir } from '../../scripts/controlled-env.mjs'
import { defineConfig } from 'vitest/config'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
  envDir: controlledEnvDir(),
  plugins: [svelte({ hot: false })],
  resolve: { conditions: ['browser'] },
  test: { environment: 'node', globals: false, include: ['src/**/*.test.ts'] },
})
