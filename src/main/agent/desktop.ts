import { desktopCapturer, screen } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { saveBlob } from '../store';
import { POWERSHELL, encodePowerShell, sleep } from '../util';
import { log } from '../events';

const MAX_W = 1366;
let lastShot = { w: 0, h: 0, physW: 0, physH: 0 };

export async function screenshotDesktop(): Promise<{ blobId: string; width: number; height: number; physW: number; physH: number }> {
  const d = screen.getPrimaryDisplay();
  const physW = Math.round(d.size.width * d.scaleFactor);
  const physH = Math.round(d.size.height * d.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } });
  const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
  if (!src) throw new Error('No screen available for capture');
  let img = src.thumbnail;
  if (img.getSize().width > MAX_W) img = img.resize({ width: MAX_W, quality: 'good' });
  const size = img.getSize();
  lastShot = { w: size.width, h: size.height, physW, physH };
  return { blobId: saveBlob(img.toPNG(), 'image/png'), width: size.width, height: size.height, physW, physH };
}

// ------------------------------------------------------------- input helper

const HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class LxIn {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public U u; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\\r') continue;
      if (c == '\\n') { keybd_event(0x0D, 0, 0, UIntPtr.Zero); keybd_event(0x0D, 0, 2, UIntPtr.Zero); System.Threading.Thread.Sleep(6); continue; }
      INPUT[] inp = new INPUT[2];
      inp[0].type = 1; inp[0].u.ki.wScan = c; inp[0].u.ki.dwFlags = 0x0004;
      inp[1].type = 1; inp[1].u.ki.wScan = c; inp[1].u.ki.dwFlags = 0x0006;
      SendInput(2, inp, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(5);
    }
  }
}
"@
[LxIn]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'move' { [LxIn]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null }
      'click' {
        [LxIn]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null; Start-Sleep -Milliseconds 40
        $down = 0x0002; $up = 0x0004
        if ($c.button -eq 'right') { $down = 0x0008; $up = 0x0010 }
        if ($c.button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
        for ($i = 0; $i -lt [int]$c.count; $i++) { [LxIn]::mouse_event($down,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 25; [LxIn]::mouse_event($up,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 70 }
      }
      'drag' {
        [LxIn]::SetCursorPos([int]$c.x, [int]$c.y) | Out-Null; Start-Sleep -Milliseconds 40
        [LxIn]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80
        [LxIn]::SetCursorPos([int]$c.x2, [int]$c.y2) | Out-Null; Start-Sleep -Milliseconds 80
        [LxIn]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
      }
      'scroll' { [LxIn]::mouse_event(0x0800, 0, 0, [int]$c.amount, [UIntPtr]::Zero) }
      'type' { [LxIn]::TypeText([string]$c.text) }
      'key' {
        $vks = @($c.vks)
        foreach ($k in $vks) { [LxIn]::keybd_event([byte]$k.vk, 0, [uint32]$k.ext, [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
        [array]::Reverse($vks)
        foreach ($k in $vks) { [LxIn]::keybd_event([byte]$k.vk, 0, [uint32]($k.ext -bor 2), [UIntPtr]::Zero); Start-Sleep -Milliseconds 15 }
      }
    }
    [Console]::Out.WriteLine('{"ok":true}')
  } catch { [Console]::Out.WriteLine('{"ok":false,"error":"' + ($_.Exception.Message -replace '"','') + '"}') }
}
`;

let helper: ChildProcess | null = null;
let buffer = '';
const waiters: ((s: string) => void)[] = [];

async function ensureHelper(): Promise<ChildProcess> {
  if (helper && helper.exitCode === null) return helper;
  helper = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(HELPER)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  buffer = '';
  helper.stdout!.on('data', (d) => {
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) waiters.shift()?.(line);
    }
  });
  helper.stderr!.on('data', (d) => log('desktop helper:', d.toString()));
  helper.on('exit', () => {
    helper = null;
    while (waiters.length) waiters.shift()?.('{"ok":false,"error":"helper exited"}');
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Desktop control helper did not start')), 20000);
    waiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
  return helper;
}

async function send(cmd: any): Promise<void> {
  const h = await ensureHelper();
  const res = await new Promise<string>((resolve) => {
    waiters.push(resolve);
    h.stdin!.write(JSON.stringify(cmd) + '\n');
  });
  const j = JSON.parse(res);
  if (!j.ok) throw new Error(j.error || 'input failed');
}

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d,
  space: 0x20, up: 0x26, down: 0x28, left: 0x25, right: 0x27, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  printscreen: 0x2c, capslock: 0x14, menu: 0x5d
};
const EXTENDED = new Set([0x26, 0x28, 0x25, 0x27, 0x24, 0x23, 0x21, 0x22, 0x2e, 0x2d, 0x5b, 0x5d]);

function vkOf(name: string): number {
  const n = name.toLowerCase().replace(/^arrow/, '');
  if (VK[n] !== undefined) return VK[n];
  if (/^f([1-9]|1[0-2])$/.test(n)) return 0x6f + Number(n.slice(1));
  if (n.length === 1) {
    const c = n.toUpperCase().charCodeAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c;
  }
  throw new Error(`Unknown key: ${name}`);
}

function toPhys(x: number, y: number) {
  const sx = lastShot.w ? lastShot.physW / lastShot.w : screen.getPrimaryDisplay().scaleFactor;
  const sy = lastShot.h ? lastShot.physH / lastShot.h : screen.getPrimaryDisplay().scaleFactor;
  return { x: Math.round(x * sx), y: Math.round(y * sy) };
}

export interface ComputerInput {
  action: 'click' | 'double_click' | 'right_click' | 'move' | 'drag' | 'type' | 'key' | 'scroll' | 'wait' | 'screenshot';
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  keys?: string;
  amount?: number;
  seconds?: number;
}

export async function computerAction(input: ComputerInput) {
  if (!lastShot.w && input.action !== 'screenshot' && input.action !== 'wait' && input.action !== 'type' && input.action !== 'key') {
    await screenshotDesktop();
  }
  switch (input.action) {
    case 'move': {
      const p = toPhys(input.x ?? 0, input.y ?? 0);
      await send({ op: 'move', ...p });
      break;
    }
    case 'click':
    case 'double_click':
    case 'right_click': {
      const p = toPhys(input.x ?? 0, input.y ?? 0);
      await send({ op: 'click', ...p, button: input.action === 'right_click' ? 'right' : 'left', count: input.action === 'double_click' ? 2 : 1 });
      break;
    }
    case 'drag': {
      const a = toPhys(input.x ?? 0, input.y ?? 0);
      const b = toPhys(input.x2 ?? 0, input.y2 ?? 0);
      await send({ op: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y });
      break;
    }
    case 'type':
      await send({ op: 'type', text: String(input.text ?? '') });
      break;
    case 'key': {
      const combo = String(input.keys || 'enter')
        .split('+')
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k) => {
          const vk = vkOf(k);
          return { vk, ext: EXTENDED.has(vk) ? 1 : 0 };
        });
      await send({ op: 'key', vks: combo });
      break;
    }
    case 'scroll':
      await send({ op: 'scroll', amount: Math.round((input.amount ?? -3) * 120) });
      break;
    case 'wait':
      await sleep(Math.min(15, Math.max(0.2, input.seconds ?? 1)) * 1000);
      break;
    case 'screenshot':
      break;
  }
  if (input.action !== 'screenshot') await sleep(450);
  return screenshotDesktop();
}

export function stopDesktopHelper() {
  try {
    helper?.kill();
  } catch {
    /* ignore */
  }
  helper = null;
}
