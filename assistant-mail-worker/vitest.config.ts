import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { readD1Migrations } from '@cloudflare/vitest-plugin'

const migrations = await readD1Migrations('./migrations')

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          ASSISTANT_MAIL_ACCESS_KEY: 'test-access-key',
          ALLOWED_FORWARDER: 'owner@gmail.com',
          ASSISTANT_MAIL_ADDRESS: 'assistant@example.com',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {},
})
