import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './scripts/wrangler.freeze-test.json' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          IMPORT_SIGNING_KEY: 'synthetic-freeze-import',
          MIGRATION_VERIFICATION_ENABLED: 'true',
          MIGRATION_AUDIENCE: 'synthetic-freeze',
          CF_VERSION_METADATA: { id: 'synthetic-freeze-version' },
        },
      },
    })),
  ],
  test: {
    include: ['tests/migration-freeze/*.test.ts'],
    setupFiles: ['./tests/worker/setup.ts'],
    sequence: { concurrent: false },
  },
});
