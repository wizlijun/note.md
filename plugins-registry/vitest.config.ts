import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        // Reuse wrangler.toml so the KV (INDEX) + R2 (PKGS) bindings are set up
        // in miniflare exactly as they are in production.
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
})
