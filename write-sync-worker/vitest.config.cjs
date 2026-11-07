const { defineWorkersConfig } = require('@cloudflare/vitest-pool-workers/config')
module.exports = defineWorkersConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    poolOptions: {
      workers: {
        isolatedStorage: false, // Each test provisions fresh random spaces; old runtime cannot stack SQLite WAL files.
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            SIGNING_KEY: 'test-signing-key-32-characters-minimum',
            PROVISION_KEY: 'test-admin-secret',
          },
        },
      },
    },
  },
})
