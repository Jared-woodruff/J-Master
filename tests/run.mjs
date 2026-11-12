// Test runner: bundles tests/*.test.ts with esbuild (the same bundler that
// builds the worklet and the render worker) and runs them under node's own
// test runner. No test framework to install.
//
//   npm test              every suite
//   npm test -- limiter   suites whose file name contains "limiter"
import { build } from 'esbuild';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const suites = readdirSync('tests')
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort();

if (suites.length === 0) {
  console.error('no test suites match');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'jmaster-tests-'));
let status = 1;
try {
  await build({
    entryPoints: suites.map((f) => `tests/${f}`),
    outdir: dir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outExtension: { '.js': '.mjs' },
    logLevel: 'warning',
  });
  const files = suites.map((f) => join(dir, f.replace(/\.ts$/, '.mjs')));
  const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit' });
  status = res.status ?? 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(status);
