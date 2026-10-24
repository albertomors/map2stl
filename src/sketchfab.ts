// Downloadable 3D models on Sketchfab (mostly Creative Commons): a much bigger catalog of
// landmarks than Wikimedia Commons. Searching needs no account; downloading needs the user's
// own (Sketchfab's terms: each user is logged in), here with their personal API token,
// kept in this browser. The license comes along and is shown with every result: some are
// NonCommercial or ShareAlike, which is for the user to respect.

const API = 'https://api.sketchfab.com/v3';
const TOKEN_KEY = 'map2stl.sketchfab-token';
const RESULTS = 12;

export interface SketchfabModel {
  uid: string;
  name: string;
  author: string;
  license: string;
  // NonCommercial or ShareAlike: shown as such.
  restricted: boolean;
  pageUrl: string;
  thumbnail?: string;
  faces: number;
  // Download size of the format we'd take (GLB, else zipped glTF).
  bytes: number;
}

// Several names for the same landmark (its English name first): each searched, results merged
// without repeats, in that order.
export async function searchSketchfabNames(names: string[], signal: AbortSignal): Promise<SketchfabModel[]> {
  const lists = await Promise.all(names.map((n) => searchSketchfab(n, signal)));
  const seen = new Set<string>();
  return lists.flat().filter((m) => !seen.has(m.uid) && seen.add(m.uid)).slice(0, RESULTS);
}

export async function searchSketchfab(query: string, signal: AbortSignal): Promise<SketchfabModel[]> {
  const params = new URLSearchParams({ type: 'models', q: query, downloadable: 'true', count: String(RESULTS) });
  const res = await fetch(`${API}/search?${params}`, { signal });
  if (!res.ok) throw new Error(`Sketchfab answered ${res.status}`);
  const json = await res.json();
  type Result = {
    uid: string;
    name: string;
    user: { displayName?: string; username: string };
    license?: { label: string };
    viewerUrl: string;
    faceCount?: number;
    thumbnails?: { images: { url: string; width: number }[] };
    archives?: Record<string, { size?: number; faceCount?: number } | undefined>;
  };
  return (json.results as Result[]).map((r) => {
    const license = r.license?.label ?? 'see the model page';
    // The smallest thumbnail that's still sharp in the list.
    const thumbs = [...(r.thumbnails?.images ?? [])].sort((a, b) => a.width - b.width);
    const archive = r.archives?.glb ?? r.archives?.gltf;
    return {
      uid: r.uid,
      name: r.name,
      author: r.user.displayName || r.user.username,
      license,
      restricted: /NonCommercial|ShareAlike|NoDerivs/i.test(license),
      pageUrl: r.viewerUrl,
      thumbnail: (thumbs.find((t) => t.width >= 200) ?? thumbs[thumbs.length - 1])?.url,
      faces: archive?.faceCount ?? r.faceCount ?? 0,
      bytes: archive?.size ?? 0,
    };
  });
}

export function sketchfabToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setSketchfabToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked (private window): asked again next time.
  }
}

export class TokenRejected extends Error {}

// The model file (a GLB, or a zip with a glTF and its files), with a name telling which.
// `onBytes` hears the bytes received so far, and the total when the server says it.
export async function downloadSketchfab(uid: string, token: string, onBytes: (bytes: number, total?: number) => void): Promise<{ data: ArrayBuffer; name: string }> {
  const res = await fetch(`${API}/models/${uid}/download`, { headers: { Authorization: `Token ${token}` } });
  if (res.status === 401 || res.status === 403) throw new TokenRejected('Sketchfab didn\'t accept the token');
  if (!res.ok) throw new Error(`Sketchfab answered ${res.status}`);
  const links: Record<string, { url: string } | undefined> = await res.json();
  const [format, link] = links.glb ? ['glb', links.glb] : links.gltf ? ['zip', links.gltf] : [null, undefined];
  if (!link) throw new Error('no GLB or glTF download for this model');
  return { data: await fetchWithProgress(link.url, onBytes), name: `${uid}.${format}` };
}

// A file's bytes, reporting progress. The total comes from the download itself: the size
// Sketchfab lists for a model isn't what's sent.
export async function fetchWithProgress(url: string, onBytes: (bytes: number, total?: number) => void): Promise<ArrayBuffer> {
  const file = await fetch(url);
  if (!file.ok || !file.body) throw new Error(`the download failed (${file.status})`);
  const length = Number(file.headers.get('content-length')) || undefined;
  const reader = file.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    // A compressed transfer reports the compressed length: then there's no total to show.
    onBytes(received, length && received <= length ? length : undefined);
  }
  return new Blob(chunks as BlobPart[]).arrayBuffer();
}
