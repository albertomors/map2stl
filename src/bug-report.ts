// "Found a bug? Report it": the "?" button in the panel's header opens a window for the user
// to describe the bug in words; Send packs that with everything needed to reproduce it (the
// context main.ts gathers, recent console errors, the browser, a screenshot of the view) into
// a zip. A browser can't email an attachment by itself, so until there's a server to receive
// it, the zip is downloaded and the user's email app opens with the message, to attach it.

import { strToU8, zipSync } from 'fflate';

// Where reports go: VITE_BUG_REPORT_EMAIL in .env.local (kept out of the repository). Without
// it, a GitHub issue is opened instead.
const EMAIL: string | undefined = import.meta.env.VITE_BUG_REPORT_EMAIL;
const ISSUES_URL = 'https://github.com/albertomors/map2stl/issues/new';
// Recent console errors and warnings kept for a report.
const MAX_LOG = 50;

interface LogEntry {
  at: string;
  level: 'error' | 'warn' | 'uncaught';
  message: string;
}

const log: LogEntry[] = [];

// Called first thing: errors from before the report was opened are the useful ones.
export function recordConsole() {
  const keep = (level: LogEntry['level'], message: string) => {
    log.push({ at: new Date().toISOString(), level, message: message.slice(0, 2000) });
    if (log.length > MAX_LOG) log.shift();
  };
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      keep(level, args.map(describe).join(' '));
      original(...args);
    };
  }
  window.addEventListener('error', (e) => keep('uncaught', e.error ? describe(e.error) : e.message));
  window.addEventListener('unhandledrejection', (e) => keep('uncaught', describe(e.reason)));
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ''}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// The browser, the screen and the graphics card: WebGL bugs are often one GPU's.
function environment() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const info = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio },
    window: { width: innerWidth, height: innerHeight },
    webgl: gl
      ? {
          vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        }
      : null,
  };
}

// `context`: the app's state (selection, view, settings, data); `screenshot`: the map or the
// 3D view as it is now.
export function setupBugReport(context: () => Record<string, unknown>, screenshot: () => Promise<Blob | null>) {
  const dialog = document.getElementById('bug-dialog') as HTMLDialogElement;
  const text = document.getElementById('bug-text') as HTMLTextAreaElement;
  const send = document.getElementById('bug-send') as HTMLButtonElement;
  const status = document.getElementById('bug-status')!;
  // Taken when the window opens: it would cover the view otherwise.
  let shot: Promise<Blob | null> = Promise.resolve(null);

  document.getElementById('bug-open')!.addEventListener('click', () => {
    // It's in the help menu: close the menu behind the window.
    document.getElementById('help-menu')?.removeAttribute('open');
    shot = screenshot().catch(() => null);
    status.textContent = '';
    send.disabled = false;
    dialog.showModal();
    text.focus();
  });
  document.getElementById('bug-cancel')!.addEventListener('click', () => dialog.close());
  // "Describe it first" no longer applies once there's something to send.
  text.addEventListener('input', () => send.disabled || (status.textContent = ''));

  send.addEventListener('click', async () => {
    const message = text.value.trim();
    if (!message) {
      status.textContent = 'Describe what happened first: what you did, what you expected, what you saw.';
      text.focus();
      return;
    }
    send.disabled = true;
    try {
      const at = new Date();
      const report = { message, at: at.toISOString(), app: { version: __APP_VERSION__, url: location.href }, ...context(), environment: environment(), console: log };
      const files: Record<string, Uint8Array> = {
        'message.txt': strToU8(message),
        'context.json': strToU8(JSON.stringify(report, null, 2)),
      };
      const image = await shot;
      if (image) files['screenshot.png'] = new Uint8Array(await image.arrayBuffer());
      const name = `map2stl-bug-${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zipSync(files)], { type: 'application/zip' }));
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);

      const subject = `map2stl bug: ${message.split('\n')[0].slice(0, 80)}`;
      const body = `${message}\n\n(Attached: ${name}, the context to reproduce it.)`;
      if (EMAIL) {
        location.href = `mailto:${EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        status.textContent = `Saved as ${name}. Your email app should open with the message: attach the file to it and send. Thank you!`;
      } else {
        window.open(`${ISSUES_URL}?title=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
        status.textContent = `Saved as ${name}. A GitHub issue opens with the message: drop the file into it and submit. Thank you!`;
      }
      text.value = '';
    } catch (err) {
      console.error('Bug report failed', err);
      status.textContent = `The report couldn't be saved: ${(err as Error).message}`;
      send.disabled = false;
    }
  });
}
