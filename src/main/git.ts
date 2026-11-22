import fsp from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus } from '@shared/types';
import { agentEnv, toolBinDirs } from './toolchain';
import { runCapture, toPosix, which } from './util';
import { oneShot } from './agent/agent';

function gitBin() {
  return which('git', toolBinDirs());
}

async function git(root: string, args: string[], timeout = 30000) {
  const bin = gitBin();
  if (!bin) throw new Error('Git is not installed');
  return runCapture(bin, ['-C', root, ...args], { timeout, env: agentEnv() });
}

export async function gitStatus(root: string): Promise<GitStatus> {
  if (!gitBin()) return { isRepo: false, gitAvailable: false, files: [] };
  const r = await git(root, ['status', '--porcelain=v1', '-b', '-uall']);
  if (r.code !== 0) return { isRepo: false, gitAvailable: true, files: [] };
  const lines = r.stdout.split(/\r?\n/).filter(Boolean);
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  const files: GitStatus['files'] = [];
  for (const l of lines) {
    if (l.startsWith('## ')) {
      const m = /^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/.exec(l);
      branch = m?.[1];
      const a = /ahead (\d+)/.exec(m?.[2] || '');
      const b = /behind (\d+)/.exec(m?.[2] || '');
      ahead = a ? Number(a[1]) : 0;
      behind = b ? Number(b[1]) : 0;
      continue;
    }
    const status = l.slice(0, 2);
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"|"$/g, '');
    files.push({ path: path.join(root, p), status: status.trim() || status });
  }
  return { isRepo: true, gitAvailable: true, branch, files, ahead, behind };
}

export async function gitDiff(root: string, file: string) {
  const rel = toPosix(path.relative(root, file));
  const r = await git(root, ['show', `HEAD:${rel}`]).catch(() => null);
  const before = r && r.code === 0 ? r.stdout : '';
  const after = await fsp.readFile(file, 'utf8').catch(() => '');
  return { before, after };
}

export async function gitInit(root: string) {
  const r = await git(root, ['init', '-b', 'main']);
  const gi = path.join(root, '.gitignore');
  try {
    await fsp.access(gi);
  } catch {
    await fsp.writeFile(gi, 'node_modules/\ndist/\nbuild/\n.env\n.venv/\n__pycache__/\n*.log\n.DS_Store\n', 'utf8');
  }
  return (r.stdout + r.stderr).trim();
}

export async function gitCommit(root: string, message: string) {
  await git(root, ['add', '-A']);
  const name = await git(root, ['config', 'user.name']);
  const args = name.stdout.trim() ? ['commit', '-m', message] : ['-c', 'user.name=Lunarix User', '-c', 'user.email=user@lunarix.local', 'commit', '-m', message];
  const r = await git(root, args, 60000);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
  return (r.stdout || r.stderr).trim();
}

export async function gitCommitMessage(root: string) {
  const stat = await git(root, ['status', '--short']);
  const diff = await git(root, ['diff', 'HEAD', '--stat']).catch(() => null);
  const full = await git(root, ['diff', 'HEAD']).catch(() => null);
  const text = `${stat.stdout}\n${diff?.stdout || ''}\n${(full?.stdout || '').slice(0, 12000)}`;
  return oneShot(
    'You write concise, conventional git commit messages.',
    `Write a git commit message for these changes. First line: imperative summary under 72 characters (Conventional Commits style). Optionally a blank line and 1-4 bullet points. Output only the message.\n\n${text}`,
    300
  );
}
