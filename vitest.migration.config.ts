import fs from 'node:fs';
import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { buildProof } from './scripts/migration-runtime-key-handoff.mjs';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './scripts/wrangler.migration-test.json' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          TEST_FENCE_SQL: fs.readFileSync('operations/migration-write-fence.sql', 'utf8'),
          TEST_FIXTURE_INSERTS: [
            'users',
            'teams',
            'team_members',
            'leaderboard_periods',
            'team_practice_periods',
            'rooms',
            'room_entries',
            'active_participations',
            'match_players',
            'practice_results',
            'import_jobs',
            'timed_practice_sessions',
            'timed_practice_results',
            'team_match_results',
            'team_period_standings',
            'sessions',
          ].flatMap((table) =>
            fs
              .readFileSync('tests/migration/fixture.sql', 'utf8')
              .split('\n')
              .filter((line) => line.startsWith(`INSERT INTO "${table}" `)),
          ),
          BOOTSTRAP_TEACHER_USERNAME: 'synthetic-teacher',
          BOOTSTRAP_TEACHER_PASSWORD: 'synthetic-password',
          BOOTSTRAP_TEACHER_NAME: 'Synthetic Teacher',
          INITIAL_STUDENT_PASSWORD: 'synthetic-password',
          PASSWORD_PEPPER: 'synthetic-pepper',
          PRACTICE_SIGNING_KEY: 'synthetic-practice-key',
          IMPORT_SIGNING_KEY: 'synthetic-import-key',
          TEST_NODE_KEY_PROOF_AUTH: buildProof(
            {
              BOOTSTRAP_TEACHER_USERNAME: 'synthetic-teacher',
              BOOTSTRAP_TEACHER_PASSWORD: 'synthetic-password',
              BOOTSTRAP_TEACHER_NAME: 'Synthetic Teacher',
              INITIAL_STUDENT_PASSWORD: 'synthetic-password',
              PASSWORD_PEPPER: 'synthetic-pepper',
              PRACTICE_SIGNING_KEY: 'synthetic-practice-key',
              IMPORT_SIGNING_KEY: 'synthetic-import-key',
            },
            'synthetic-migration',
          ).authorization,
        },
      },
    })),
  ],
  test: {
    include: ['tests/migration/*.test.ts'],
    setupFiles: ['./tests/migration/setup.ts'],
    sequence: { concurrent: false },
  },
});
