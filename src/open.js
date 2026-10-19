import { spawn } from 'node:child_process';
import { log } from './config.js';

const recentlyOpened = new Map();

/** Open a URL in the default browser. De-duplicated: the same URL opens at most once per 20s. */
export function openBrowser(url, { force = false } = {}) {
  if (process.env.DESIGN_HUB_NO_OPEN === '1') return { opened: false, reason: 'DESIGN_HUB_NO_OPEN=1' };
  const last = recentlyOpened.get(url);
  if (!force && last && Date.now() - last < 20000) return { opened: false, reason: 'already opened just now' };
  let cmd; let args;
  if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (process.platform === 'win32') { cmd = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; }
  else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return { opened: false, reason: 'no graphical display' };
    cmd = 'xdg-open'; args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => log(`could not open browser: ${e.message}`));
    child.unref();
    recentlyOpened.set(url, Date.now());
    return { opened: true };
  } catch (e) {
    return { opened: false, reason: e.message };
  }
}
