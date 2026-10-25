// Search with suggestions while typing, from Photon (photon.komoot.io): OpenStreetMap data,
// free, no API key, typo tolerant. Towns, streets, addresses and landmarks ("Eiffel Tower",
// "Via Roma 12, Modena"), ranked by fame and then by closeness to where the map is. Also the
// town a point is in (for searching a landmark's models by name and town).

import type { Map } from 'maplibre-gl';
import { distance, type LngLat } from './geo';
import type { Selection } from './selection';

// More than are shown: the noise (bus stops, shops) and the pieces of one street are
// dropped or merged first.
const PHOTON_URL = 'https://photon.komoot.io/api/?limit=15';
const SHOWN = 6;
// Photon names results in these languages; anything else gets English, which also matches
// the English names of famous places ("Eiffel Tower" finds nothing in Paris without it).
const LANGUAGES = ['en', 'de', 'fr'];

interface PhotonProperties {
  name?: string;
  // house, street, locality, district, city, county, state, country, or other.
  type?: string;
  osm_key?: string;
  osm_value?: string;
  housenumber?: string;
  street?: string;
  district?: string;
  locality?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  // [minLng, maxLat, maxLng, minLat]
  extent?: [number, number, number, number];
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: PhotonProperties;
}

type Kind = 'place' | 'street' | 'address' | 'landmark';

interface Result {
  kind: Kind;
  title: string;
  label: string;
  where: string;
  center: LngLat;
  // [minLng, minLat, maxLng, maxLat], when known.
  bounds?: [number, number, number, number];
}

const PLACE_TYPES = ['city', 'district', 'locality', 'county', 'state', 'country'];
// Amenities worth printing; the rest (restaurants, ATMs, parking) are noise in a search
// for places.
const LANDMARK_AMENITIES = new Set([
  'place_of_worship', 'townhall', 'university', 'college', 'school', 'theatre', 'library', 'hospital',
  'arts_centre', 'marketplace', 'fountain', 'courthouse', 'monastery', 'grave_yard', 'clock', 'planetarium',
]);
const NOISE_KEYS = new Set(['shop', 'craft', 'office', 'emergency', 'healthcare', 'public_transport']);
// How close to fly in when a result has no extent, and how close at most when it has one.
const ZOOM: Record<Kind, number> = { place: 13, street: 16.5, address: 17.5, landmark: 17 };
const MAX_ZOOM: Record<Kind, number> = { place: 15, street: 17, address: 17.5, landmark: 17.5 };
// A selection dropped on a result: its extent and some ground around it, within limits.
const MIN_HALF_M = 150;
const MAX_HALF_M = 2500;

function kindOf(p: PhotonProperties): Kind {
  if (PLACE_TYPES.includes(p.type ?? '')) return 'place';
  if (p.type === 'street') return 'street';
  if (!p.name && p.housenumber) return 'address';
  return 'landmark';
}

// Transport stops, shops and the like share names with the places people look for
// ("Duomo" the bus stop, "Colosseum" the bar).
function isNoise(p: PhotonProperties, kind: Kind): boolean {
  if (kind !== 'landmark') return false;
  if (!p.name) return true;
  if (NOISE_KEYS.has(p.osm_key ?? '')) return true;
  if (p.osm_key === 'railway') return p.osm_value !== 'station';
  if (p.osm_key === 'highway') return true;
  if (p.osm_key === 'amenity') return !LANDMARK_AMENITIES.has(p.osm_value ?? '');
  return false;
}

function humanize(tag: string): string {
  const s = tag.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function toResult(f: PhotonFeature): Result | null {
  const p = f.properties;
  const kind = kindOf(p);
  if (isNoise(p, kind)) return null;
  const town = p.city ?? p.locality ?? p.county;
  const title = kind === 'address' ? `${p.street ?? ''} ${p.housenumber}`.trim() : p.name ?? 'Unnamed place';
  const label =
    kind === 'place'
      ? humanize(p.osm_key === 'boundary' ? p.type! : p.osm_value ?? p.type ?? 'place')
      : kind === 'street'
        ? 'Street'
        : kind === 'address'
          ? 'Address'
          : humanize(p.osm_value && p.osm_value !== 'yes' ? p.osm_value : p.osm_key ?? 'place');
  const parts = kind === 'place' ? [p.county, p.state, p.country] : [kind === 'street' ? p.district : undefined, town, p.state, p.country];
  const where = [...new Set(parts.filter((s): s is string => !!s && s !== title))].join(', ');
  const e = p.extent;
  return { kind, title, label, where, center: f.geometry.coordinates, bounds: e && [e[0], e[3], e[2], e[1]] };
}

const boundsOf = (r: Result): [number, number, number, number] => r.bounds ?? [r.center[0], r.center[1], r.center[0], r.center[1]];

// Whether two results are within about two kilometers of each other.
function near(a: Result, b: Result): boolean {
  const [aw, as, ae, an] = boundsOf(a);
  const [bw, bs, be, bn] = boundsOf(b);
  const pad = 0.02;
  return aw - pad <= be && bw - pad <= ae && as - pad <= bn && bs - pad <= an;
}

// One result per thing. Results with the same name, near each other or in the same town,
// are pieces or parts of one thing: a long street or bridge comes back a piece at a time
// (Golden Gate Bridge: eleven pieces in two counties), a landmark with its office and screen
// (the Eiffel Tower), a road named after a landmark (the Golden Gate Bridge's motorway,
// Rome's Piazza del Colosseo). Each group shows as its first landmark (or its first result
// without one), spanning every piece of the same kind as that one.
function merge(results: Result[]): Result[] {
  const sameThing = (a: Result, b: Result) =>
    a.title === b.title && (near(a, b) || a.where === b.where) && (a.kind === b.kind || (a.kind !== 'place' && b.kind !== 'place'));
  // Grouped transitively: piece 1 touches piece 2, which touches piece 3.
  const group = results.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < results.length; i++) {
    for (let j = 0; j < i; j++) if (sameThing(results[i], results[j])) group[root(i)] = root(j);
  }
  const merged: Result[] = [];
  results.forEach((_, i) => {
    if (root(i) !== i) return;
    const members = results.filter((_, j) => root(j) === i);
    const lead = members.find((m) => m.kind === 'landmark') ?? members[0];
    const pieces = members.filter((m) => m.kind === lead.kind && m.label === lead.label).map(boundsOf);
    const bounds: [number, number, number, number] = [
      Math.min(...pieces.map((b) => b[0])),
      Math.min(...pieces.map((b) => b[1])),
      Math.max(...pieces.map((b) => b[2])),
      Math.max(...pieces.map((b) => b[3])),
    ];
    const center: LngLat = pieces.length > 1 ? [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2] : lead.center;
    merged.push({ ...lead, center, bounds: lead.bounds || pieces.length > 1 ? bounds : undefined });
  });
  return merged;
}

// A rectangle around a result, facing north: its extent with some ground around it.
function selectionAround(r: Result): Selection {
  const [w, s, e, n] = r.bounds ?? [r.center[0], r.center[1], r.center[0], r.center[1]];
  const center: LngLat = [(w + e) / 2, (s + n) / 2];
  const half = (m: number) => Math.min(Math.max(m * 0.65 + 50, MIN_HALF_M), MAX_HALF_M);
  return {
    kind: 'rectangle',
    center,
    halfWidth: half(distance([w, center[1]], [e, center[1]])),
    halfHeight: half(distance([center[0], s], [center[0], n])),
    rotation: 0,
  };
}

// The name of the town or city a point is in, or undefined.
export async function townAt([lng, lat]: [number, number], signal: AbortSignal): Promise<string | undefined> {
  const res = await fetch(`https://photon.komoot.io/reverse?lon=${lng}&lat=${lat}&layer=city&limit=1`, { signal });
  if (!res.ok) return undefined;
  const json: { features?: PhotonFeature[] } = await res.json();
  const p = json.features?.[0]?.properties;
  return p?.city ?? p?.name;
}

// `onSelect` puts a selection around a result (the "Select" button on streets, addresses and
// landmarks).
export function setupSearch(
  map: Map,
  form: HTMLFormElement,
  input: HTMLInputElement,
  list: HTMLUListElement,
  onSelect: (sel: Selection) => void,
) {
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let results: Result[] = [];
  let active = -1;
  const lang = LANGUAGES.find((l) => navigator.language.startsWith(l)) ?? 'en';

  const render = () => {
    list.replaceChildren(
      ...results.map((r, i) => {
        const li = document.createElement('li');
        li.className = i === active ? 'active' : '';
        const text = document.createElement('div');
        const title = document.createElement('strong');
        title.textContent = r.title;
        const kind = document.createElement('em');
        kind.textContent = r.label;
        const where = document.createElement('span');
        where.textContent = r.where;
        text.append(title, kind, where);
        li.append(text);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          go(r);
        });
        if (r.kind !== 'place') {
          const select = document.createElement('button');
          select.type = 'button';
          select.className = 'secondary';
          select.textContent = 'Select';
          select.title = 'Go there and select the area around it';
          select.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            go(r, true);
          });
          li.append(select);
        }
        return li;
      }),
    );
    list.hidden = results.length === 0;
  };

  const go = (r: Result, select = false) => {
    input.value = r.title;
    results = [];
    render();
    input.blur();
    if (select) {
      const sel = selectionAround(r);
      onSelect(sel);
      const dLng = sel.halfWidth / (111_320 * Math.cos((sel.center[1] * Math.PI) / 180));
      const dLat = sel.halfHeight / 110_540;
      const [lng, lat] = sel.center;
      map.fitBounds([[lng - dLng, lat - dLat], [lng + dLng, lat + dLat]], { padding: 80, duration: 2000 });
    } else if (r.bounds) {
      map.fitBounds([[r.bounds[0], r.bounds[1]], [r.bounds[2], r.bounds[3]]], { padding: 40, maxZoom: MAX_ZOOM[r.kind], duration: 2000 });
    } else {
      map.flyTo({ center: r.center, zoom: ZOOM[r.kind], duration: 2000 });
    }
  };

  const query = async (q: string) => {
    controller?.abort();
    controller = new AbortController();
    // Nearer results first among equally known ones; the bias fades as the map zooms out.
    const { lng, lat } = map.getCenter();
    const bias = `&lat=${lat.toFixed(4)}&lon=${lng.toFixed(4)}&zoom=${Math.round(map.getZoom())}`;
    try {
      const res = await fetch(`${PHOTON_URL}&lang=${lang}${bias}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
      const features: PhotonFeature[] = (await res.json()).features ?? [];
      results = merge(features.map(toResult).filter((r): r is Result => r !== null)).slice(0, SHOWN);
      active = -1;
      render();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') console.warn('Search failed', err);
    }
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) {
      results = [];
      render();
      return;
    }
    timer = window.setTimeout(() => query(q), 250);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (results.length) go(results[Math.max(active, 0)]);
  });

  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && results.length) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
  input.addEventListener('blur', () => (list.hidden = true));
  input.addEventListener('focus', () => {
    if (results.length) list.hidden = false;
  });
}
