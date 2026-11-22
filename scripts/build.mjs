// Lunarix build script: bundles main + preload with esbuild and the renderer with Vite.
import { build as esbuild } from 'esbuild';
import { build as viteBuild } from 'vite';
import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'out');
const dev = process.argv.includes('--dev');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

const t0 = Date.now();
if (!only) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  keepNames: true,
  logLevel: 'warning',
  alias: { '@shared': resolve(root, 'src/shared') },
  define: { 'process.env.LUNARIX_BUILD': JSON.stringify(dev ? 'dev' : 'prod') }
};

if (!only || only === 'main') {
  await esbuild({
    ...common,
    entryPoints: [resolve(root, 'src/main/index.ts')],
    outfile: resolve(out, 'main/index.js'),
    external: ['electron', 'node-pty']
  });
  await esbuild({
    ...common,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(out, 'preload/index.js'),
    external: ['electron']
  });
  console.log('main + preload bundled');
}

if (!only || only === 'renderer') {
  await viteBuild({
    configFile: resolve(root, 'vite.config.ts'),
    logLevel: 'warn',
    mode: dev ? 'development' : 'production'
  });
  console.log('renderer built');
}

if (existsSync(resolve(root, 'assets'))) {
  cpSync(resolve(root, 'assets'), resolve(out, 'assets'), { recursive: true });
}
console.log(`build finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
