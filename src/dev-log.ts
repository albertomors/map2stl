// Records from real use, for tuning the app's estimates (the download time, the size of the
// requests): in the dev server only, each record is appended as a JSON line to
// debug/<name>.jsonl (see vite.config.ts). A production build leaves this out.

export function devLog(name: string, record: Record<string, unknown>) {
  if (!import.meta.env.DEV) return;
  fetch(`/__dev-log/${name}`, { method: 'POST', body: JSON.stringify({ at: new Date().toISOString(), ...record }) }).catch(() => {});
}
