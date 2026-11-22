// End-to-end test of the forced update window against a fake GitHub release API.
// Builds nothing: run `node scripts/build.mjs` first.
// Usage: node scripts/run-update-test.mjs [outDir]
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || join(root, 'test-output-update'));

const setup = randomBytes(3 * 1024 * 1024); // stands in for lunarix-setup.exe
const sha = createHash('sha256').update(setup).digest('hex');

const server = createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url.startsWith('/repos/xczaros/lunarix/releases/latest')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: 'v1.0.1',
        name: 'Lunarix 1.0.1',
        draft: false,
        prerelease: false,
        html_url: 'https://github.com/xczaros/lunarix/releases/tag/v1.0.1',
        published_at: '2026-11-22T12:00:00Z',
        body: '## Nowości\n- Plan zadań sam się odhacza i znika po skończonej pracy\n- Menu zamyka się po ponownym kliknięciu\n\n## Poprawki\n- Drobne poprawki stabilności',
        assets: [
          { name: 'lunarix-setup.exe', size: setup.length, digest: `sha256:${sha}`, browser_download_url: `${base}/download/lunarix-setup.exe` }
        ]
      })
    );
    return;
  }
  if (req.url === '/download/lunarix-setup.exe') {
    // slow on purpose, so the progress bar can be seen and captured
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': setup.length });
    let off = 0;
    const step = 96 * 1024;
    const t = setInterval(() => {
      if (off >= setup.length) {
        clearInterval(t);
        res.end();
        return;
      }
      res.write(setup.subarray(off, off + step));
      off += step;
    }, 90);
    req.on('close', () => clearInterval(t));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const env = {
    ...process.env,
    LUNARIX_UPDATE_URL: `http://127.0.0.1:${port}/repos/xczaros/lunarix/releases/latest`,
    LUNARIX_UPDATE_CURRENT: '1.0.0',
    LUNARIX_UPDATE_DRYRUN: '1',
    LUNARIX_UPDATE_EXPECT_SIZE: String(setup.length),
    LUNARIX_TEST_SCRIPT: join(root, 'scripts', 'update-test.js')
  };
  const child = spawn(process.execPath, [join(root, 'scripts', 'run-ui-test.mjs'), outDir], { env, stdio: 'inherit' });
  child.on('exit', (code) => {
    server.close();
    process.exit(code ?? 1);
  });
});
