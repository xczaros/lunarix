// Renders assets/logo.svg into PNGs and a multi-resolution Windows .ico.
import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(resolve(root, 'assets/logo.svg'));
const out = resolve(root, 'assets');
mkdirSync(out, { recursive: true });

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = {};
for (const s of [...sizes, 512, 1024]) {
  pngs[s] = await sharp(svg, { density: Math.max(72, (s / 512) * 72 * 4) }).resize(s, s).png({ compressionLevel: 9 }).toBuffer();
}
writeFileSync(resolve(out, 'icon.png'), pngs[512]);
writeFileSync(resolve(out, 'icon-256.png'), pngs[256]);
writeFileSync(resolve(out, 'icon-1024.png'), pngs[1024]);
writeFileSync(resolve(out, 'icon-64.png'), pngs[64]);

// ICO container with embedded PNG images (Vista+ format)
const entries = sizes.map((s) => ({ s, data: pngs[s] }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + dir.length;
entries.forEach((e, i) => {
  const o = i * 16;
  dir.writeUInt8(e.s >= 256 ? 0 : e.s, o);
  dir.writeUInt8(e.s >= 256 ? 0 : e.s, o + 1);
  dir.writeUInt8(0, o + 2);
  dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4);
  dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(e.data.length, o + 8);
  dir.writeUInt32LE(offset, o + 12);
  offset += e.data.length;
});
writeFileSync(resolve(out, 'icon.ico'), Buffer.concat([header, dir, ...entries.map((e) => e.data)]));
console.log('icons written:', Object.keys(pngs).join(', '), '+ icon.ico');
