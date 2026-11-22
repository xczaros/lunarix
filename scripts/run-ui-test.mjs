// Runs the Electron app in an isolated data dir with a scripted UI walkthrough and screenshots.
// Usage: node scripts/run-ui-test.mjs <outDir> [--keep-data]
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || join(root, 'test-output'));
const dataDir = join(outDir, 'data');
if (!process.argv.includes('--keep-data')) rmSync(dataDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const shots = join(outDir, 'shots');
rmSync(shots, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });

const env = {
  ...process.env,
  LUNARIX_TEST: '1',
  LUNARIX_MOCK: '1',
  LUNARIX_DATA_DIR: dataDir,
  LUNARIX_TEST_SCRIPT: process.env.LUNARIX_TEST_SCRIPT || join(root, 'scripts', 'ui-test.js'),
  LUNARIX_TEST_OUT: shots
};
delete env.ELECTRON_RUN_AS_NODE;

// LUNARIX_EXE=<path to packaged Lunarix.exe> tests the packaged build instead of the dev tree
const exe = process.env.LUNARIX_EXE || electronPath;
const child = spawn(exe, process.env.LUNARIX_EXE ? [] : [root], { env, stdio: 'inherit' });
const timer = setTimeout(() => {
  console.error('UI test timed out — killing app');
  child.kill();
}, Number(process.env.LUNARIX_TEST_TIMEOUT || 240000));
child.on('exit', (code) => {
  clearTimeout(timer);
  const log = join(shots, 'test-log.txt');
  if (existsSync(log)) console.log(readFileSync(log, 'utf8'));
  const con = join(shots, 'console.txt');
  if (existsSync(con)) console.log('--- console errors ---\n' + readFileSync(con, 'utf8').slice(0, 6000));
  console.log('exit code', code, 'shots in', shots);
});
