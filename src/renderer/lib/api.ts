import type { LunarixApi } from '@shared/api';

declare global {
  interface Window {
    lunarix: {
      invoke(method: string, ...args: any[]): Promise<any>;
      on(type: string, cb: (payload: any) => void): () => void;
      pathForFile(file: File): string;
      titlebarTheme(): void;
      platform: string;
    };
    lunarixTest?: {
      capture(name: string): Promise<string>;
      log(msg: string): Promise<void>;
      quit(): Promise<void>;
    };
  }
}

export function cleanError(e: any): string {
  return String(e?.message || e || 'Error').replace(/^Error invoking remote method 'lx':\s*(Error:\s*)?/, '');
}

export const api: LunarixApi = new Proxy({} as LunarixApi, {
  get(_t, prop: string) {
    return (...args: any[]) =>
      window.lunarix.invoke(prop, ...args).catch((e: any) => {
        throw new Error(cleanError(e));
      });
  }
});

export function on(type: string, cb: (payload: any) => void): () => void {
  return window.lunarix.on(type, cb);
}

export const isMac = () => window.lunarix?.platform === 'darwin';
