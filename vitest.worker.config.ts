import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
      return {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BOOTSTRAP_TEACHER_USERNAME: 'teacher',
            BOOTSTRAP_TEACHER_PASSWORD: 'integration-teacher-password',
            BOOTSTRAP_TEACHER_NAME: '测试教师',
            INITIAL_STUDENT_PASSWORD: 'integration-student-password',
            PASSWORD_PEPPER: 'integration-password-pepper',
            PRACTICE_SIGNING_KEY: 'integration-practice-key',
            IMPORT_SIGNING_KEY: 'integration-import-key',
            PBKDF2_ITERATIONS: '100000',
          },
        },
      };
    }),
  ],
  test: {
    include: ['tests/worker/**/*.test.ts'],
    setupFiles: ['./tests/worker/setup.ts'],
    sequence: { concurrent: false },
  },
});
