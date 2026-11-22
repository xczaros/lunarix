import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { agentEnv, refreshPathFromRegistry } from './toolchain';
import { POWERSHELL, encodePowerShell, isWin, killTree, stripAnsi, uid, which } from './util';

export interface RunOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  shell?: 'auto' | 'powershell' | 'cmd';
  background?: boolean;
  waitMs?: number;
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  background: boolean;
  processId?: string;
  durationMs: number;
  shell: string;
}

interface BgProc {
  id: string;
  child: ChildProcess;
  command: string;
  cwd: string;
  startedAt: number;
  output: string;
  dropped: number; // number of chars dropped from the front of `output`
  readPos: number; // absolute char position already returned to the model
  exited: boolean;
  exitCode: number | null;
  listeners: Set<(s: string) => void>;
}

const procs = new Map<string, BgProc>();
const MAX_BUF = 400_000;

function hasChainOps(cmd: string) {
  let q: string | null = null;
  for (let i = 0; i < cmd.length - 1; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) return true;
  }
  return false;
}

function pickShell(cmd: string, pref: RunOptions['shell']): { file: string; args: string[]; name: string; verbatim: boolean } {
  if (!isWin) return { file: '/bin/bash', args: ['-lc', cmd], name: 'bash', verbatim: false };
  const pwsh = which('pwsh');
  let choice = pref && pref !== 'auto' ? pref : 'powershell';
  if ((!pref || pref === 'auto') && hasChainOps(cmd) && !pwsh) choice = 'cmd';
  if (choice === 'cmd') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"chcp 65001>nul & ${cmd}"`], name: 'cmd', verbatim: true };
  }
  const script =
    "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$OutputEncoding=[System.Text.Encoding]::UTF8;\n" +
    cmd +
    '\nif ($LASTEXITCODE) { exit $LASTEXITCODE }';
  const file = pwsh || POWERSHELL;
  return { file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)], name: pwsh ? 'pwsh' : 'powershell', verbatim: false };
}

function appendOut(p: BgProc, s: string) {
  p.output += s;
  if (p.output.length > MAX_BUF) {
    const cut = p.output.length - MAX_BUF;
    p.output = p.output.slice(cut);
    p.dropped += cut;
  }
  for (const l of p.listeners) l(s);
}

const INSTALL_HINT = /\b(winget|choco|scoop|msiexec|setx)\b/i;

export function runCommand(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const sh = pickShell(opts.command, opts.shell);
  const cwd = fs.existsSync(opts.cwd) ? opts.cwd : process.cwd();
  const child = spawn(sh.file, sh.args, { cwd, env: agentEnv(), windowsHide: true, windowsVerbatimArguments: sh.verbatim });
  const id = uid('proc_');
  const proc: BgProc = { id, child, command: opts.command, cwd, startedAt: started, output: '', dropped: 0, readPos: 0, exited: false, exitCode: null, listeners: new Set() };
  procs.set(id, proc);
  const dec1 = new TextDecoder('utf-8');
  const dec2 = new TextDecoder('utf-8');
  child.stdout?.on('data', (d: Buffer) => appendOut(proc, stripAnsi(dec1.decode(d, { stream: true }))));
  child.stderr?.on('data', (d: Buffer) => appendOut(proc, stripAnsi(dec2.decode(d, { stream: true }))));
  child.stdin?.end();
  if (opts.onOutput) proc.listeners.add(opts.onOutput);

  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (background: boolean, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (opts.onOutput) proc.listeners.delete(opts.onOutput);
      clearTimeout(timer);
      clearInterval(readyPoll);
      const out = proc.output;
      proc.readPos = proc.dropped + proc.output.length;
      if (!background) procs.delete(id);
      if (!background && INSTALL_HINT.test(opts.command)) refreshPathFromRegistry().catch(() => {});
      resolve({ exitCode: background ? null : proc.exitCode, output: out, timedOut, background, processId: background ? id : undefined, durationMs: Date.now() - started, shell: sh.name });
    };
    child.on('error', (e) => {
      appendOut(proc, `\n[spawn error] ${e.message}\n`);
      proc.exited = true;
      proc.exitCode = -1;
      finish(false, false);
    });
    child.on('close', (code) => {
      proc.exited = true;
      proc.exitCode = code;
      const tail1 = dec1.decode();
      const tail2 = dec2.decode();
      if (tail1 || tail2) appendOut(proc, stripAnsi(tail1 + tail2));
      if (!settled) finish(false, false);
    });
    const waitMs = opts.background ? opts.waitMs ?? 7000 : opts.timeoutMs;
    const timer = setTimeout(() => finish(true, !opts.background), Math.max(500, waitMs));
    // background processes return early once a dev server looks ready
    const readyPoll = setInterval(() => {
      if (opts.background && /(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0):\d{2,5}|ready in|listening on|compiled successfully|server running|started server/i.test(proc.output) && Date.now() - started > 1200) {
        setTimeout(() => finish(true, false), 600);
      }
    }, 300);
    opts.signal?.addEventListener(
      'abort',
      () => {
        killTree(child.pid);
        appendOut(proc, '\n[przerwano przez użytkownika]\n');
        proc.exited = true;
        finish(false, false);
      },
      { once: true }
    );
  });
}

export function processOutput(id: string): { found: boolean; output: string; exited: boolean; exitCode: number | null; command?: string; runningFor?: number } {
  const p = procs.get(id);
  if (!p) return { found: false, output: '', exited: true, exitCode: null };
  const start = Math.max(0, p.readPos - p.dropped);
  const out = p.output.slice(start);
  p.readPos = p.dropped + p.output.length;
  return { found: true, output: out, exited: p.exited, exitCode: p.exitCode, command: p.command, runningFor: Date.now() - p.startedAt };
}

export function stopProcess(id: string): boolean {
  const p = procs.get(id);
  if (!p) return false;
  killTree(p.child.pid);
  procs.delete(id);
  return true;
}

export function listProcesses() {
  return [...procs.values()].map((p) => ({ id: p.id, command: p.command, cwd: p.cwd, exited: p.exited, startedAt: p.startedAt }));
}

export function killAllProcesses() {
  for (const p of procs.values()) killTree(p.child.pid);
  procs.clear();
}
