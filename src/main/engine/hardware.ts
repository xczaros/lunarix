import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GpuInfo, HardwareInfo, LocalTierId, MeasuredSpeed, TierRating } from '@shared/types';
import { LOCAL_TIERS } from '@shared/catalog';
import { powershell, runCapture, which } from '../util';
import { settings, updateSettings } from '../settings';
import { emit, log } from '../events';

let cached: HardwareInfo | null = null;

/** Identifies the hardware (and backend choice) a speed measurement belongs to. */
export function hwFingerprint(info: HardwareInfo) {
  const g = info.bestGpu;
  return [g?.dedicated ? `${g.name}/${g.vramGB}` : 'cpu', info.cpu.model, settings().local.backend].join('|');
}

/**
 * Records the real generation speed of a local tier (llama-server timings) as a moving average.
 * After a few samples it replaces the estimate in ratings and recommendations.
 */
export function recordLocalSpeed(tier: LocalTierId, tps: number) {
  if (!cached || !(tps > 0) || !isFinite(tps)) return;
  const fp = hwFingerprint(cached);
  const s = settings();
  const prev = s.local.measured?.[tier];
  const next: MeasuredSpeed =
    prev && prev.hw === fp
      ? { tps: prev.tps * 0.75 + tps * 0.25, samples: Math.min(9999, prev.samples + 1), at: Date.now(), hw: fp }
      : { tps, samples: 1, at: Date.now(), hw: fp };
  updateSettings({ local: { ...s.local, measured: { ...(s.local.measured || {}), [tier]: next } } });
  emit('hardware', { ...cached, ...rate(cached) });
}

function vendorOf(name: string): GpuInfo['vendor'] {
  const n = name.toLowerCase();
  if (/nvidia|geforce|quadro|rtx|gtx|tesla/.test(n)) return 'nvidia';
  if (/amd|radeon|ati /.test(n)) return 'amd';
  if (/intel|iris|uhd|arc/.test(n)) return 'intel';
  return 'other';
}

function isDedicated(name: string, vramGB: number) {
  const n = name.toLowerCase();
  if (/microsoft basic|remote|virtual|parsec|meta virtual|citrix|vmware|hyper-v/.test(n)) return false;
  if (vendorOf(name) === 'intel' && !/arc/.test(n)) return false;
  if (vendorOf(name) === 'amd' && /radeon\(tm\) graphics|vega \d graphics|radeon graphics$/.test(n) && vramGB < 4) return false;
  return vramGB >= 1.5;
}

export async function detectHardware(force = false): Promise<HardwareInfo> {
  if (cached && !force) return { ...cached, ...rate(cached) };
  const cpus = os.cpus();
  const info: HardwareInfo = {
    cpu: { model: cpus[0]?.model?.trim() || 'CPU', cores: Math.max(1, Math.round(cpus.length / 2)), threads: cpus.length },
    ramGB: os.totalmem() / 1024 ** 3,
    freeRamGB: os.freemem() / 1024 ** 3,
    gpus: [],
    diskFreeGB: 0,
    os: `${os.type()} ${os.release()}`,
    recommended: 'medium',
    ratings: {} as any
  };
  if (process.platform === 'win32') {
    const script = `
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors
$osx = Get-CimInstance Win32_OperatingSystem | Select-Object Caption
$gpus = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM, DriverVersion)
$reg = @(Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' | Select-Object DriverDesc, @{n='Mem';e={$_.'HardwareInformation.qwMemorySize'}})
[pscustomobject]@{ cpu=$cpu; os=$osx.Caption; gpus=$gpus; reg=$reg } | ConvertTo-Json -Depth 4 -Compress`;
    try {
      const r = await powershell(script, 25000);
      const j = JSON.parse(r.stdout.trim() || '{}');
      if (j.cpu) {
        info.cpu = { model: String(j.cpu.Name || info.cpu.model).trim(), cores: j.cpu.NumberOfCores || info.cpu.cores, threads: j.cpu.NumberOfLogicalProcessors || info.cpu.threads };
      }
      if (j.os) info.os = j.os;
      const reg: any[] = Array.isArray(j.reg) ? j.reg : j.reg ? [j.reg] : [];
      const gpus: any[] = Array.isArray(j.gpus) ? j.gpus : j.gpus ? [j.gpus] : [];
      for (const g of gpus) {
        const name = String(g.Name || 'GPU');
        const regEntry = reg.find((x) => x && String(x.DriverDesc || '').trim() === name.trim() && Number(x.Mem) > 0);
        const bytes = regEntry ? Number(regEntry.Mem) : Number(g.AdapterRAM) || 0;
        const vram = bytes / 1024 ** 3;
        info.gpus.push({ name, vendor: vendorOf(name), vramGB: Math.round(vram * 10) / 10, dedicated: isDedicated(name, vram), driver: g.DriverVersion });
      }
    } catch (e) {
      log('hardware detection failed', e);
    }
    // NVIDIA: exact VRAM + CUDA version
    const smi = which('nvidia-smi') || (fs.existsSync('C:\\Windows\\System32\\nvidia-smi.exe') ? 'C:\\Windows\\System32\\nvidia-smi.exe' : null);
    if (smi) {
      try {
        const q = await runCapture(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { timeout: 8000 });
        for (const line of q.stdout.trim().split(/\r?\n/)) {
          const [name, mem, driver] = line.split(',').map((s) => s.trim());
          if (!name) continue;
          const vram = Number(mem) / 1024;
          const ex = info.gpus.find((g) => g.name.toLowerCase().includes(name.toLowerCase().replace('nvidia ', '')) || name.toLowerCase().includes(g.name.toLowerCase().replace('nvidia ', '')));
          if (ex) {
            ex.vramGB = Math.round(vram * 10) / 10;
            ex.dedicated = true;
            ex.driver = driver;
          } else info.gpus.push({ name, vendor: 'nvidia', vramGB: Math.round(vram * 10) / 10, dedicated: true, driver });
        }
        const h = await runCapture(smi, [], { timeout: 8000 });
        const cm = /CUDA(?: UMD)? Version:\s*([\d.]+)/i.exec(h.stdout);
        if (cm) info.cudaVersion = cm[1];
      } catch {
        /* ignore */
      }
    }
  }
  info.bestGpu = [...info.gpus].filter((g) => g.dedicated).sort((a, b) => b.vramGB - a.vramGB)[0];
  try {
    const dir = settings().local.modelsDir || os.homedir();
    let probe = dir;
    while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    const st = fs.statfsSync(probe);
    info.diskFreeGB = (st.bavail * st.bsize) / 1024 ** 3;
  } catch {
    info.diskFreeGB = 0;
  }
  info.ramGB = Math.round(info.ramGB * 10) / 10;
  info.freeRamGB = Math.round(info.freeRamGB * 10) / 10;
  cached = info;
  return { ...info, ...rate(info) };
}

function gpuBandwidth(g?: GpuInfo) {
  if (!g) return 0;
  const n = g.name.toLowerCase();
  const table: [RegExp, number][] = [
    [/5090/, 1790], [/4090/, 1008], [/3090/, 936], [/5080/, 960], [/4080/, 717], [/3080/, 760], [/5070 ti/, 896], [/4070 ti/, 504], [/5070/, 672], [/4070/, 504], [/3070/, 448],
    [/5060 ti/, 448], [/4060 ti/, 288], [/5060/, 448], [/4060/, 272], [/3060/, 360], [/3050/, 224], [/2080/, 448], [/2070/, 448], [/2060/, 336], [/1660/, 192], [/1080/, 320], [/1070/, 256], [/1060/, 192],
    [/7900/, 960], [/7800/, 624], [/7700/, 432], [/7600/, 288], [/6900|6950/, 512], [/6800/, 512], [/6700/, 384], [/6600/, 224], [/arc a7/, 512], [/arc b5/, 456], [/arc/, 300]
  ];
  for (const [re, bw] of table) if (re.test(n)) return bw;
  if (g.vramGB >= 20) return 700;
  if (g.vramGB >= 12) return 450;
  if (g.vramGB >= 8) return 300;
  return 200;
}

const MIN_SAMPLES = 3;

export function rate(info: HardwareInfo): { recommended: LocalTierId; ratings: Record<LocalTierId, TierRating>; fingerprint: string } {
  const ratings = {} as Record<LocalTierId, TierRating>;
  const fp = hwFingerprint(info);
  const measured = settings().local.measured || {};
  const P = settings().language === 'pl';
  const gpu = info.bestGpu;
  const vram = gpu?.dedicated ? gpu.vramGB : 0;
  // Calibrated against a real run: RTX 3050 6 GB + i5-10400F, Qwen3.5 9B Q4 partially offloaded ≈ 4.5 tok/s.
  const gpuBW = gpuBandwidth(gpu) * 0.5;
  const cpuBW = Math.min(50, 10 + info.cpu.cores * 2) * 0.6;
  let recommended: LocalTierId = 'low';
  for (const t of LOCAL_TIERS) {
    const modelGB = t.sizeGB + t.mmprojGB;
    const kvGB = (t.kvBytesPerToken * t.defaultContext) / 1024 ** 3;
    const need = modelGB + kvGB + 0.8;
    const activeGB = t.moe ? t.activeParamsB * 0.62 : t.sizeGB;
    let offload: TierRating['gpuOffload'] = 'none';
    let frac = 0;
    if (vram >= need) {
      offload = 'full';
      frac = 1;
    } else if (vram >= 2) {
      offload = 'partial';
      frac = Math.max(0, Math.min(1, (vram - kvGB - 1 - t.mmprojGB) / t.sizeGB));
    }
    // splitting a model between GPU and CPU adds synchronisation overhead
    const time = frac > 0 && gpuBW > 0 ? ((activeGB * frac) / gpuBW + (activeGB * (1 - frac)) / cpuBW) * (frac < 1 ? 1.15 : 1) : activeGB / cpuBW;
    const estimate = 1 / Math.max(time, 0.001);
    // a real measurement on this machine beats any estimate
    const m = measured[t.id];
    const isMeasured = !!m && m.hw === fp && m.samples >= MIN_SAMPLES && m.tps > 0;
    const tps = isMeasured ? m!.tps : estimate;
    const memOk = isMeasured || (info.ramGB + (offload !== 'none' ? vram * 0.9 : 0) >= modelGB + kvGB + 2.5 && info.ramGB >= t.minRamGB * 0.85);
    let rating: TierRating['rating'];
    if (!memOk) rating = 'unsupported';
    else if (tps >= 22) rating = 'great';
    else if (tps >= 10) rating = 'good';
    else if (tps >= 3 || isMeasured) rating = 'slow';
    else rating = 'unsupported';
    const num = tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
    ratings[t.id] = {
      rating,
      gpuOffload: offload,
      speed: !memOk ? '—' : isMeasured ? `${num} tok/s · ${P ? 'zmierzone' : 'measured'}` : `~${num} tok/s`,
      tps: memOk ? Math.round(tps * 10) / 10 : undefined,
      measured: isMeasured
    };
    // An agent writes thousands of tokens per task, so speed matters more than raw size:
    // recommend the strongest tier that still runs at a comfortable speed.
    if (rating === 'great' || (rating === 'good' && tps >= 14)) recommended = t.id;
  }
  return { recommended, ratings, fingerprint: fp };
}
