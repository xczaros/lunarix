import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { emit, log } from './events';
import { agentEnv } from './toolchain';
import { POWERSHELL, isWin, killTree, uid, which } from './util';

type PtyModule = typeof import('node-pty');
let ptyMod: PtyModule | null | undefined;

function loadPty(): PtyModule | null {
  if (ptyMod !== undefined) return ptyMod;
  const candidates: string[] = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'node-pty'));
  candidates.push('node-pty');
  for (const c of candidates) {
    try {
      if (c !== 'node-pty' && !fs.existsSync(c)) continue;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ptyMod = require(c);
      return ptyMod!;
    } catch (e) {
      log('node-pty load failed from', c, e);
    }
  }
  ptyMod = null;
  return null;
}

interface Term {
  id: string;
  pty?: import('node-pty').IPty;
  proc?: ChildProcess;
}
const terms = new Map<string, Term>();

export function defaultShell(): { file: string; args: string[]; name: string } {
  if (!isWin) return { file: process.env.SHELL || '/bin/bash', args: [], name: 'bash' };
  const pwsh = which('pwsh');
  if (pwsh) return { file: pwsh, args: ['-NoLogo'], name: 'pwsh' };
  return { file: POWERSHELL, args: ['-NoLogo'], name: 'powershell' };
}

export function createTerminal(cwd: string, cols: number, rows: number) {
  const id = uid('t_');
  const shell = defaultShell();
  const env = { ...agentEnv(), TERM: 'xterm-256color', COLORTERM: 'truecolor', LUNARIX: '1' } as Record<string, string>;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const safeCwd = fs.existsSync(cwd) ? cwd : process.env.USERPROFILE || process.cwd();
  const pty = loadPty();
  if (pty) {
    try {
      const p = pty.spawn(shell.file, shell.args, { name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows), cwd: safeCwd, env });
      const t: Term = { id, pty: p };
      terms.set(id, t);
      p.onData((data) => emit('terminal:data', { id, data }));
      p.onExit(({ exitCode }) => {
        terms.delete(id);
        emit('terminal:exit', { id, code: exitCode });
      });
      return { id, pty: true, shell: shell.name };
    } catch (e) {
      log('pty spawn failed, fallback to pipes', e);
    }
  }
  // Fallback: plain pipes with cmd.exe (prompts render without a PTY)
  const file = isWin ? process.env.ComSpec || 'cmd.exe' : shell.file;
  const proc = spawn(file, isWin ? ['/Q', '/K', 'chcp 65001>nul'] : ['-i'], { cwd: safeCwd, env, windowsHide: true });
  const t: Term = { id, proc };
  terms.set(id, t);
  proc.stdout?.on('data', (d) => emit('terminal:data', { id, data: d.toString().replace(/\r?\n/g, '\r\n') }));
  proc.stderr?.on('data', (d) => emit('terminal:data', { id, data: d.toString().replace(/\r?\n/g, '\r\n') }));
  proc.on('exit', (code) => {
    terms.delete(id);
    emit('terminal:exit', { id, code });
  });
  return { id, pty: false, shell: isWin ? 'cmd' : shell.name };
}

export function writeTerminal(id: string, data: string) {
  const t = terms.get(id);
  if (!t) return;
  if (t.pty) t.pty.write(data);
  else if (t.proc?.stdin) {
    // emulate local echo for pipe mode
    const echo = data.replace(/\r/g, '\r\n');
    emit('terminal:data', { id, data: echo });
    t.proc.stdin.write(data.replace(/\r/g, '\r\n'));
  }
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const t = terms.get(id);
  if (t?.pty) {
    try {
      t.pty.resize(Math.max(20, cols), Math.max(5, rows));
    } catch {
      /* ignore */
    }
  }
}

export function killTerminal(id: string) {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  try {
    if (t.pty) {
      const pid = t.pty.pid;
      try {
        t.pty.kill();
      } catch {
        killTree(pid);
      }
    } else if (t.proc) killTree(t.proc.pid);
  } catch {
    /* ignore */
  }
}

export function killAllTerminals() {
  // On app exit kill the process trees directly (node-pty's own kill forks a helper that fails while quitting).
  for (const [id, t] of [...terms.entries()]) {
    terms.delete(id);
    killTree(t.pty?.pid ?? t.proc?.pid);
  }
}
