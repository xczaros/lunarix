import { contextBridge, ipcRenderer, webUtils } from 'electron';

type Listener = (payload: any) => void;
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on('lx:event', (_e, ev: { type: string; payload: any }) => {
  const set = listeners.get(ev.type);
  if (set) for (const l of set) {
    try {
      l(ev.payload);
    } catch (err) {
      console.error('listener error', ev.type, err);
    }
  }
  const all = listeners.get('*');
  if (all) for (const l of all) l(ev);
});

contextBridge.exposeInMainWorld('lunarix', {
  invoke: (method: string, ...args: any[]) => ipcRenderer.invoke('lx', method, ...args),
  on: (type: string, cb: Listener) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  },
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  titlebarTheme: () => ipcRenderer.send('lx:titlebar-theme'),
  platform: process.platform
});

if (process.argv.includes('--lunarix-test')) {
  contextBridge.exposeInMainWorld('lunarixTest', {
    capture: (name: string) => ipcRenderer.invoke('lx:test-capture', name),
    log: (msg: string) => ipcRenderer.invoke('lx:test-log', msg),
    quit: () => ipcRenderer.invoke('lx:test-quit')
  });
}
