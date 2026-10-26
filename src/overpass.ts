// Overpass API client: public OSM query servers, free, no API key, shared fair use.
// Tries mirrors in turn when one is busy, and caches answers in the browser for a week
// so re-fetching the same area costs nothing.

// overpass.private.coffee was dropped in October 2026: it answered 1 of 38 requests, and
// let the other 37 run into the timeout (100 s each).
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// After a refusal: wait, then double the wait for each further refusal (what the server asks
// for), up to a cap, with some jitter so many users don't retry in lockstep.
const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_ATTEMPTS = 8;
// Busy mirrors sometimes accept the request and never answer: move on after this.
// Dense city centers can legitimately take a minute.
const ATTEMPT_TIMEOUT_MS = 100_000;
// The main server says when its next slot frees up; mirrors don't have this page.
const STATUS_URL = 'https://overpass-api.de/api/status';
const MAX_SLOT_WAIT_S = 60;
const CACHE_NAME = 'map2stl-overpass-v1';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: ({ lat: number; lon: number } | null)[];
  members?: { type: string; ref: number; role: string; geometry?: ({ lat: number; lon: number } | null)[] }[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

export interface OverpassStatus {
  server?: string;
  bytes: number;
  cached: boolean;
  // Seconds left waiting before the next try (a free slot, or backing off after a refusal).
  waitS?: number;
  // Once answered: seconds from sending the request that answered to its last byte, and
  // how many requests it took (busy servers, mirrors).
  answeredS?: number;
  tries?: number;
}

// The server gave up on the query (its time or memory limit): a smaller area may go through.
export class TooMuchData extends Error {
  constructor() {
    super('The area has too much data for the OSM server. Try a smaller selection.');
  }
}

export async function overpass(query: string, signal: AbortSignal, onProgress: (status: OverpassStatus) => void): Promise<OverpassResponse> {
  const cached = await readCache(query);
  if (cached) {
    onProgress({ bytes: cached.length, cached: true });
    return JSON.parse(cached);
  }

  let lastError: Error = new Error('No Overpass server answered');
  let backoff = BACKOFF_START_MS;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    const server = new URL(url).host;
    // The main server tells us when a slot frees: wait for it instead of being refused.
    if (url.startsWith('https://overpass-api.de/')) {
      const waitS = await slotWait(signal);
      if (waitS > 0) await countdown(waitS * 1000, signal, (s) => onProgress({ server, bytes: 0, cached: false, waitS: s }));
    }
    onProgress({ server, bytes: 0, cached: false });
    const sentAt = performance.now();
    let received = 0;
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: attemptSignal });
      // 429 = rate limited, 5xx = at capacity or timed out: back off, then try the next server.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${server} busy (${res.status})`);
        const retryAfter = Number(res.headers.get('Retry-After'));
        const wait = retryAfter > 0 ? retryAfter * 1000 : backoff;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        await countdown(wait * (0.85 + Math.random() * 0.3), signal, (s) => onProgress({ server, bytes: 0, cached: false, waitS: s }));
        continue;
      }
      if (!res.ok) throw new Error(`Overpass rejected the query (${res.status})`);
      text = await readBody(res, (bytes) => onProgress({ server, bytes: (received = bytes), cached: false }));
    } catch (err) {
      if (signal.aborted) throw err;
      if ((err as Error).message.startsWith('Overpass rejected')) throw err;
      lastError = new Error(`${server} ${attemptSignal.aborted ? 'did not answer in time' : 'unreachable'}`);
      continue;
    }

    const json = JSON.parse(text) as OverpassResponse;
    // Timeouts and memory limits come back as 200 with partial data and a remark.
    if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new TooMuchData();
    onProgress({ server, bytes: received, cached: false, answeredS: (performance.now() - sentAt) / 1000, tries: attempt + 1 });
    await writeCache(query, text);
    return json;
  }
  throw lastError;
}

// Seconds until the main server has a free slot for us: 0 when one is free now, or when the
// status page itself doesn't answer quickly (then the request just tries).
async function slotWait(signal: AbortSignal): Promise<number> {
  try {
    const res = await fetch(STATUS_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!res.ok) return 0;
    const text = await res.text();
    if (/(\d+) slots? available now/.test(text) && !/^0 slots/m.test(text)) return 0;
    const waits = [...text.matchAll(/in (-?\d+) seconds/g)].map((m) => Number(m[1])).filter((n) => n >= 0);
    return waits.length ? Math.min(Math.min(...waits) + 1, MAX_SLOT_WAIT_S) : 0;
  } catch {
    if (signal.aborted) throw signal.reason;
    return 0;
  }
}

// Waits `ms`, reporting the whole seconds left once a second.
async function countdown(ms: number, signal: AbortSignal, onTick: (secondsLeft: number) => void) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    onTick(Math.ceil((end - Date.now()) / 1000));
    await sleep(Math.min(1000, end - Date.now()), signal);
  }
}

async function readBody(res: Response, onBytes: (bytes: number) => void): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received);
  }
  return new Blob(chunks as BlobPart[]).text();
}

// The Cache API only stores GET requests, so each query gets a made-up URL from its hash.
async function cacheKey(query: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(query));
  const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `https://cache.map2stl.local/overpass/${hex}`;
}

async function readCache(query: string): Promise<string | null> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(await cacheKey(query));
    if (!res) return null;
    if (Date.now() - Number(res.headers.get('x-saved-at')) > CACHE_TTL_MS) return null;
    return await res.text();
  } catch {
    // No Cache API (insecure origin, private mode): just fetch.
    return null;
  }
}

async function writeCache(query: string, text: string) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const headers = { 'content-type': 'application/json', 'x-saved-at': String(Date.now()) };
    await cache.put(await cacheKey(query), new Response(text, { headers }));
  } catch {
    // Quota or no Cache API: the next fetch goes to the network again.
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
