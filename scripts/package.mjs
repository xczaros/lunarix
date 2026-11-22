// Packages Lunarix into dist/lunarix-setup.exe:
//   1. @electron/packager → dist/Lunarix-win32-x64
//   2. Electron fuses hardening
//   3. zip payload
//   4. compile the custom WPF installer (installer/Setup.cs) with Roslyn from the .NET SDK
//   5. installer stub + payload + footer → lunarix-setup.exe
import { packager } from '@electron/packager';
import { flipFuses, FuseVersion, FuseV1Options } from '@electron/fuses';
import yazl from 'yazl';
import { createWriteStream, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const t0 = Date.now();
const step = (s) => console.log(`\n▶ ${s}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

if (!existsSync(join(root, 'out', 'main', 'index.js'))) throw new Error('Run "npm run build" first');

// ------------------------------------------------------------- 1. package
step('Packaging Electron app');
const appDir = join(dist, 'Lunarix-win32-x64');
rmSync(appDir, { recursive: true, force: true });
const [packaged] = await packager({
  dir: root,
  out: dist,
  name: 'Lunarix',
  executableName: 'Lunarix',
  platform: 'win32',
  arch: 'x64',
  electronVersion,
  appVersion: pkg.version,
  buildVersion: pkg.version,
  icon: join(root, 'assets', 'icon.ico'),
  // taskbar/window icons must live outside app.asar
  extraResource: [join(root, 'assets', 'icon.ico'), join(root, 'assets', 'icon.png')],
  asar: { unpack: '**/node_modules/node-pty/**' },
  overwrite: true,
  prune: true,
  quiet: true,
  ignore: [
    /^\/src($|\/)/,
    /^\/scripts($|\/)/,
    /^\/installer($|\/)/,
    /^\/dist($|\/)/,
    /^\/assets($|\/)/,
    /^\/test-output/,
    /^\/tsconfig\.json$/,
    /^\/vite\.config\.ts$/,
    /^\/README/i,
    /^\/node_modules\/node-pty\/(deps|src|third_party|scripts|typings|build)($|\/)/,
    /^\/node_modules\/node-pty\/prebuilds\/(darwin|linux|win32-arm64)/,
    /\.pdb$/,
    /\.map$/
  ],
  win32metadata: {
    CompanyName: 'Lunarix',
    FileDescription: 'Lunarix',
    OriginalFilename: 'Lunarix.exe',
    ProductName: 'Lunarix',
    InternalName: 'Lunarix'
  },
  appCopyright: 'Copyright © 2026 Lunarix'
});
console.log('  packaged to', packaged);
writeFileSync(join(packaged, 'resources', 'lunarix-version.txt'), pkg.version);
// keep only the UI languages Lunarix ships (Polish + English) — saves ~40 MB
const localesDir = join(packaged, 'locales');
if (existsSync(localesDir)) {
  for (const f of readdirSync(localesDir)) if (!/^(en-US|pl)\.pak$/i.test(f)) rmSync(join(localesDir, f), { force: true });
}

// ------------------------------------------------------------- 2. fuses
step('Hardening with Electron fuses');
await flipFuses(join(packaged, 'Lunarix.exe'), {
  version: FuseVersion.V1,
  // RunAsNode must stay enabled: node-pty forks a helper process through the app executable.
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
});

// ------------------------------------------------------------- 3. payload zip
step('Compressing payload');
const payloadZip = join(dist, 'payload.zip');
rmSync(payloadZip, { force: true });
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(packaged);
let rawBytes = 0;
await new Promise((resolveZip, reject) => {
  const zip = new yazl.ZipFile();
  for (const f of files) {
    const rel = relative(packaged, f).split(sep).join('/');
    const size = statSync(f).size;
    rawBytes += size;
    zip.addFile(f, rel, { compress: true });
  }
  zip.outputStream.pipe(createWriteStream(payloadZip)).on('close', resolveZip).on('error', reject);
  zip.end();
});
const zipBytes = statSync(payloadZip).size;
console.log(`  ${files.length} files, ${(rawBytes / 1048576).toFixed(1)} MB → ${(zipBytes / 1048576).toFixed(1)} MB`);

// ------------------------------------------------------------- 4. installer stub
step('Compiling installer (C# / WPF)');
const fw = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319';
const sdkRoot = 'C:\\Program Files\\dotnet\\sdk';
const allSdks = existsSync(sdkRoot) ? readdirSync(sdkRoot).filter((d) => existsSync(join(sdkRoot, d, 'Roslyn', 'bincore', 'csc.dll'))) : [];
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });
const stable = allSdks.filter((d) => !d.includes('-')).sort(byVersion);
const sdks = stable.length ? stable : allSdks.sort(byVersion);
const stub = join(dist, 'installer-build', 'LunarixSetup.exe');
mkdirSync(dirname(stub), { recursive: true });
const refs = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Xml.dll', 'System.Xaml.dll', 'WPF\\WindowsBase.dll', 'WPF\\PresentationCore.dll', 'WPF\\PresentationFramework.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'].map((r) => `/reference:${join(fw, r)}`);
const common = [
  '/nologo',
  '/noconfig',
  '/nostdlib+',
  '/target:winexe',
  '/platform:anycpu',
  '/optimize+',
  `/out:${stub}`,
  `/win32icon:${join(root, 'assets', 'icon.ico')}`,
  `/win32manifest:${join(root, 'installer', 'app.manifest')}`,
  ...refs,
  `/resource:${join(root, 'installer', 'Setup.xaml')},Lunarix.Setup.xaml`,
  `/resource:${join(root, 'assets', 'icon-256.png')},Lunarix.Icon.png`,
  join(root, 'installer', 'Setup.cs')
];
if (sdks.length) {
  const csc = join(sdkRoot, sdks[sdks.length - 1], 'Roslyn', 'bincore', 'csc.dll');
  execFileSync('dotnet', [csc, '/langversion:latest', ...common], { stdio: 'inherit' });
} else {
  // .NET Framework's built-in compiler (C# 5) as a fallback
  execFileSync(join(fw, 'csc.exe'), common, { stdio: 'inherit' });
}

// ------------------------------------------------------------- 5. assemble
step('Assembling lunarix-setup.exe');
const setup = join(dist, 'lunarix-setup.exe');
const stubBuf = readFileSync(stub);
const fd = openSync(setup, 'w');
writeSync(fd, stubBuf);
await new Promise((res, rej) => {
  const rs = createReadStream(payloadZip, { highWaterMark: 1 << 20 });
  rs.on('data', (chunk) => writeSync(fd, chunk));
  rs.on('end', res);
  rs.on('error', rej);
});
const footer = Buffer.alloc(16);
footer.write('LNRXPAY1', 0, 'ascii');
footer.writeBigInt64LE(BigInt(zipBytes), 8);
writeSync(fd, footer);
closeSync(fd);
console.log(`\n✔ ${setup}  (${(statSync(setup).size / 1048576).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
