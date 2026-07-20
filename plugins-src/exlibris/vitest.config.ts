import { defineConfig } from 'vitest/config'
import path from 'node:path'

// The exlibris plugin's own vitest project. Runs the ported pure-logic tests
// (bookname/dedup/meta/rules/verify/rebuild/import-pipeline/rules-io/
// shared-config/sotvault-fs). The backend-boundary tests mock `./bridge`
// (the host RPC accessor) exactly as the v1 tests mocked `@tauri-apps/api/core`.
export default defineConfig({
  resolve: {
    alias: { $lib: path.resolve(__dirname, 'src/lib') },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
  },
})
