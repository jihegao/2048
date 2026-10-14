import { build } from 'esbuild';

await build({
  entryPoints: ['worker/migration-source-verification.mjs'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  external: ['./__2048_original_module__.js'],
  outfile: 'operations/source-verification-wrapper.mjs',
});
