// End-to-end test of the OpenAI-compatible and Anthropic adapters + agent loop against a fake LLM server.
// Usage: node scripts/run-provider-test.mjs <outDir>
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { startFakeLLM } from './fake-llm.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] || join(root, 'test-output-providers'));
rmSync(outDir, { recursive: true, force: true });
const shots = join(outDir, 'shots');
mkdirSync(shots, { recursive: true });

// ---- attachment fixtures
import JSZip from 'jszip';
import sharp from 'sharp';
const fx = join(outDir, 'fixtures');
mkdirSync(fx, { recursive: true });
{
  const zip = new JSZip();
  zip.file('index.php', '<?php\necho "Hello from PHP";\n');
  zip.file('README.md', '# Sample project\nZIP attachment test\n');
  zip.file('src/app.cs', 'class App { static void Main() { System.Console.WriteLine("C#"); } }\n');
  writeFileSync(join(fx, 'sample.zip'), await zip.generateAsync({ type: 'nodebuffer' }));
  const docx = new JSZip();
  docx.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  docx.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hello DOCX</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>');
  writeFileSync(join(fx, 'sample.docx'), await docx.generateAsync({ type: 'nodebuffer' }));
  // minimal valid PDF with one text line
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = 'BT /F1 18 Tf 20 100 Td (Hello PDF) Tj ET';
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(fx, 'sample.pdf'), pdf, 'latin1');
  await sharp({ create: { width: 64, height: 48, channels: 3, background: '#808080' } }).png().toFile(join(fx, 'shot.png'));
}

const fake = await startFakeLLM(join(outDir, 'fake-llm.log'));
const script = readFileSync(join(root, 'scripts', 'provider-test.js'), 'utf8').replace('__PORT__', String(fake.port)).replace('__FIXTURES__', JSON.stringify(fx));
const scriptFile = join(outDir, 'provider-test.generated.js');
writeFileSync(scriptFile, script);

const env = {
  ...process.env,
  LUNARIX_TEST: '1',
  LUNARIX_DATA_DIR: join(outDir, 'data'),
  LUNARIX_TEST_SCRIPT: scriptFile,
  LUNARIX_TEST_OUT: shots,
  LUNARIX_ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`
};
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, [root], { env, stdio: 'inherit' });
const timer = setTimeout(() => child.kill(), 180000);
child.on('exit', (code) => {
  clearTimeout(timer);
  fake.close();
  const log = join(shots, 'test-log.txt');
  if (existsSync(log)) console.log(readFileSync(log, 'utf8'));
  console.log('--- fake server log ---\n' + readFileSync(join(outDir, 'fake-llm.log'), 'utf8'));
  const con = join(shots, 'console.txt');
  if (existsSync(con)) console.log('--- console errors ---\n' + readFileSync(con, 'utf8').slice(0, 4000));
  console.log(fake.problems.length ? `VALIDATION PROBLEMS: ${fake.problems.length}` : 'VALIDATION: OK', 'exit', code);
  process.exit(0);
});
