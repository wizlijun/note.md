import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        // Disable per-test isolated storage so shared Durable Objects
        // (e.g. __pending_index__) don't cause sqlite-shm teardown failures.
        // singleWorker ensures all test files run in the same Miniflare
        // instance, avoiding the "inserted row already exists" crash that
        // occurs when multiple workers share a DO class with the same name.
        isolatedStorage: false,
        singleWorker: true,
      },
    },
  },
});
