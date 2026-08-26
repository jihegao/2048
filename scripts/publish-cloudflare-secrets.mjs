import { spawnSync } from 'node:child_process';

const names = [
  'BOOTSTRAP_TEACHER_USERNAME',
  'BOOTSTRAP_TEACHER_PASSWORD',
  'BOOTSTRAP_TEACHER_NAME',
  'INITIAL_STUDENT_PASSWORD',
  'PASSWORD_PEPPER',
  'PRACTICE_SIGNING_KEY',
  'IMPORT_SIGNING_KEY',
];

const missing = names.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required deployment secrets: ${missing.join(', ')}`);
  process.exit(1);
}

const secrets = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const result = spawnSync('npx', ['wrangler', 'secret', 'bulk'], {
  input: `${JSON.stringify(secrets)}\n`,
  stdio: ['pipe', 'inherit', 'inherit'],
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
