// Overpass API client: public OSM query servers, free, no API key, shared fair use.
// Tries mirrors in turn when one is busy, and caches answers in the browser for a week
// so re-fetching the same area costs nothing.

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const ROUNDS = 2;
const RETRY_DELAY_MS = 3000;
// Busy mirrors sometimes accept the request and never answer: move on after this.
// Dense city centers can legitimately take a minute.
const ATTEMPT_TIMEOUT_MS = 100_000;
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

export async function overpass(
  query: string,
  signal: AbortSignal,
  onProgress: (status: { server?: string; bytes: number; cached: boolean }) => void,
): Promise<OverpassResponse> {
  const cached = await readCache(query);
  if (cached) {
    onProgress({ bytes: cached.length, cached: true });
    return JSON.parse(cached);
  }

  let lastError: Error = new Error('No Overpass server answered');
  for (let attempt = 0; attempt < ENDPOINTS.length * ROUNDS; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    // Every server was busy: give them a moment before the next round.
    if (attempt > 0 && attempt % ENDPOINTS.length === 0) await sleep(RETRY_DELAY_MS * (attempt / ENDPOINTS.length), signal);
    const server = new URL(url).host;
    onProgress({ server, bytes: 0, cached: false });
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)]);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal: attemptSignal });
      // 429 = rate limited, 5xx = overloaded or timed out: another server may do better.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${server} busy (${res.status})`);
        continue;
      }
      if (!res.ok) throw new Error(`Overpass rejected the query (${res.status})`);
      text = await readBody(res, (bytes) => onProgress({ server, bytes, cached: false }));
    } catch (err) {
      if (signal.aborted) throw err;
      if ((err as Error).message.startsWith('Overpass rejected')) throw err;
      lastError = new Error(`${server} ${attemptSignal.aborted ? 'did not answer in time' : 'unreachable'}`);
      continue;
    }

    const json = JSON.parse(text) as OverpassResponse;
    // Timeouts and memory limits come back as 200 with partial data and a remark.
    if (json.remark && /error|timed out|out of memory/i.test(json.remark)) {
      throw new Error('The area has too much data for the OSM server. Try a smaller selection.');
    }
    await writeCache(query, text);
    return json;
  }
  throw lastError;
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
