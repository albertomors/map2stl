// "Found a bug? Report it": the "?" button in the panel's header opens a window for the user
// to describe the bug in words; Send packs that with everything needed to reproduce it (the
// context main.ts gathers, recent console errors, the browser, a screenshot of the view) into
// one report. The site's /api/bug-report function (functions/api/bug-report.ts) turns it into a
// GitHub issue. Where that function isn't there (the dev server) or fails, the report is
// downloaded as a zip instead and a prefilled GitHub issue opens, to attach it by hand.

import { strToU8, zipSync } from 'fflate';

const ENDPOINT = '/api/bug-report';
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
      const image = await shot;
      const subject = message.split('\n')[0].slice(0, 80);
      status.textContent = 'Sending…';

      const sent = await post(message, report, image);
      if (sent) {
        status.textContent = 'Sent as ';
        const link = document.createElement('a');
        link.href = sent.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `issue #${sent.number}`;
        status.append(link, '. Thank you!');
      } else {
        const files: Record<string, Uint8Array> = {
          'message.txt': strToU8(message),
          'context.json': strToU8(JSON.stringify(report, null, 2)),
        };
        if (image) files['screenshot.png'] = new Uint8Array(await image.arrayBuffer());
        const name = `map2stl-bug-${at.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.zip`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([zipSync(files)], { type: 'application/zip' }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        const body = `${message}\n\n(Attached: ${name}, the context to reproduce it.)`;
        window.open(`${ISSUES_URL}?title=${encodeURIComponent(`Bug report: ${subject}`)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
        status.textContent = `Couldn't send it directly, so it's saved as ${name}. A GitHub issue opens with the message: drop the file into it and submit. Thank you!`;
      }
      text.value = '';
    } catch (err) {
      console.error('Bug report failed', err);
      status.textContent = `The report couldn't be saved: ${(err as Error).message}`;
      send.disabled = false;
    }
  });
}

// The report to the site's function. null when there is no function (the dev server) or it
// fails: the caller falls back to the zip.
async function post(message: string, report: Record<string, unknown>, image: Blob | null) {
  const form = new FormData();
  form.set('message', message);
  form.set('context', JSON.stringify(report));
  if (image) form.set('screenshot', image, 'screenshot.png');
  form.set('website', (document.getElementById('bug-website') as HTMLInputElement | null)?.value ?? '');
  try {
    const res = await fetch(ENDPOINT, { method: 'POST', body: form });
    if (!res.ok) return null;
    const data = (await res.json()) as { number?: number; url?: string };
    return data.url && data.number ? { number: data.number, url: data.url } : null;
  } catch {
    return null;
  }
}
