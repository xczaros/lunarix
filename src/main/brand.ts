import { app, nativeImage, Notification, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { paths } from './paths';
import { log } from './events';

const isTest = !!process.env.LUNARIX_TEST;

/**
 * Windows taskbar identity (AppUserModelID). Development/test runs go through electron.exe, so they
 * get their own ID: when they shared the installed app's ID, Windows remembered electron.exe's atom
 * icon and "Electron" name for Lunarix itself.
 */
export const AUMID = app.isPackaged ? 'com.lunarix.desktop' : 'com.lunarix.desktop.dev';

let cachedIcon: Electron.NativeImage | null = null;

/** Multi-resolution .ico loaded from disk (outside app.asar) for crisp taskbar / Alt+Tab icons. */
export function appIconImage(): Electron.NativeImage {
  if (cachedIcon && !cachedIcon.isEmpty()) return cachedIcon;
  let img = nativeImage.createFromPath(paths.appIcon);
  if (img.isEmpty()) img = nativeImage.createFromPath(paths.appIconPng);
  if (img.isEmpty()) log('WARNING: app icon could not be loaded from', paths.appIcon);
  cachedIcon = img;
  return img;
}

/**
 * Gives a window Lunarix's identity on the Windows taskbar: icon and name.
 * The window icon alone is not enough — for a process with an AppUserModelID the taskbar takes the
 * button icon from the executable, so a dev/test build (electron.exe) showed Electron's atom icon.
 * The per-window relaunch icon + display name make every Lunarix window show the Lunarix logo.
 */
export function brandWindow(win: BrowserWindow) {
  const icon = appIconImage();
  if (!icon.isEmpty()) win.setIcon(icon);
  if (process.platform !== 'win32') return;
  try {
    win.setAppDetails({
      appId: AUMID,
      appIconPath: paths.appIcon,
      appIconIndex: 0,
      relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Lunarix'
    });
  } catch (e) {
    log('setAppDetails failed', e);
  }
}

/**
 * Windows takes the name and icon in a toast's header from the AppUserModelID's registration.
 * Without one (and without a matching Start-menu shortcut) it falls back to the exe's own name,
 * so a toast said "Electron". Registering the ID under HKCU makes every toast say "Lunarix" with
 * our logo — independent of shortcuts. Per-user, no admin rights; the uninstaller removes it.
 */
export function registerNotificationIdentity() {
  if (process.platform !== 'win32' || isTest) return;
  const key = `HKCU\\Software\\Classes\\AppUserModelId\\${AUMID}`;
  const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const set = (name: string, value: string) =>
    execFile(reg, ['add', key, '/v', name, '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true }, (err) => err && log('AUMID registration failed', name, err.message));
  set('DisplayName', app.isPackaged ? 'Lunarix' : 'Lunarix (dev)');
  set('IconUri', paths.appIconPng);
  set('IconBackgroundColor', '00000000');
}

/** One place for desktop notifications: Lunarix identity, and never from automated test runs. */
export function showNotification(opts: { title: string; body?: string; onClick?: () => void }) {
  if (isTest || !Notification.isSupported()) return;
  try {
    const n = new Notification({ title: opts.title, body: opts.body || '', icon: paths.appIconPng });
    if (opts.onClick) n.on('click', opts.onClick);
    n.show();
  } catch (e) {
    log('notification failed', e);
  }
}
