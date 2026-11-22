import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testRoot = process.env.LUNARIX_DATA_DIR;

function ensure(p: string) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
  return p;
}

function localRoot() {
  if (testRoot) return path.join(testRoot, 'local');
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'Lunarix');
}

export const paths = {
  get userData() {
    return app.getPath('userData');
  },
  get data() {
    return ensure(path.join(this.userData, 'data'));
  },
  get chats() {
    return ensure(path.join(this.data, 'chats'));
  },
  get blobs() {
    return ensure(path.join(this.data, 'blobs'));
  },
  get attachments() {
    return ensure(path.join(this.data, 'attachments'));
  },
  get checkpoints() {
    return ensure(path.join(this.data, 'checkpoints'));
  },
  get logs() {
    return ensure(path.join(this.userData, 'logs'));
  },
  get local() {
    return ensure(localRoot());
  },
  get engine() {
    return ensure(path.join(this.local, 'engine'));
  },
  get defaultModels() {
    return path.join(this.local, 'models');
  },
  get tools() {
    return ensure(path.join(this.local, 'tools'));
  },
  get temp() {
    return ensure(path.join(this.local, 'temp'));
  },
  get documents() {
    try {
      return app.getPath('documents');
    } catch {
      return path.join(os.homedir(), 'Documents');
    }
  },
  get defaultProjectsRoot() {
    if (testRoot) return path.join(testRoot, 'projects');
    return path.join(this.documents, 'Lunarix Projects');
  },
  get assets() {
    // out/main/index.js -> out/assets
    return path.join(__dirname, '..', 'assets');
  },
  /**
   * Window / taskbar icon. Windows cannot load taskbar icons from inside app.asar,
   * so the packaged app ships icon.ico next to app.asar (resources/icon.ico).
   */
  get appIcon() {
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'icon.ico'), path.join(process.resourcesPath, 'icon.png')]
      : [path.join(this.assets, 'icon.ico'), path.join(this.assets, 'icon.png')];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  },
  get appIconPng() {
    const candidates = app.isPackaged ? [path.join(process.resourcesPath, 'icon.png')] : [path.join(this.assets, 'icon.png')];
    return candidates.find((p) => fs.existsSync(p)) || this.appIcon;
  },
  get renderer() {
    return path.join(__dirname, '..', 'renderer');
  },
  get preload() {
    return path.join(__dirname, '..', 'preload', 'index.js');
  }
};

export function ensureDir(p: string) {
  return ensure(p);
}
