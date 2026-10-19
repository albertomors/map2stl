// City search with suggestions while typing, from Photon (photon.komoot.io):
// OpenStreetMap data, free, no API key, typo tolerant.

import type { Map } from 'maplibre-gl';

// Only places, not streets, shops or monuments.
const PHOTON_URL =
  'https://photon.komoot.io/api/?limit=6&layer=city&layer=district&layer=locality&layer=county&layer=state&layer=country';

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string;
    type?: string;
    county?: string;
    state?: string;
    country?: string;
    // [minLng, maxLat, maxLng, minLat]
    extent?: [number, number, number, number];
  };
}

export function setupSearch(map: Map, form: HTMLFormElement, input: HTMLInputElement, list: HTMLUListElement) {
  let timer: number | undefined;
  let controller: AbortController | undefined;
  let results: PhotonFeature[] = [];
  let active = -1;

  const render = () => {
    list.replaceChildren(
      ...results.map((f, i) => {
        const li = document.createElement('li');
        li.className = i === active ? 'active' : '';
        const title = document.createElement('strong');
        title.textContent = f.properties.name ?? 'Unnamed place';
        const sub = document.createElement('span');
        const p = f.properties;
        sub.textContent = [p.county, p.state, p.country].filter((s) => s && s !== p.name).join(', ');
        li.append(title, sub);
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          go(f);
        });
        return li;
      }),
    );
    list.hidden = results.length === 0;
  };

  const go = (f: PhotonFeature) => {
    input.value = f.properties.name ?? '';
    results = [];
    render();
    input.blur();
    const ext = f.properties.extent;
    if (ext) {
      map.fitBounds([[ext[0], ext[3]], [ext[2], ext[1]]], { padding: 40, maxZoom: 15, duration: 2000 });
    } else {
      map.flyTo({ center: f.geometry.coordinates, zoom: 13, duration: 2000 });
    }
  };

  const query = async (q: string) => {
    controller?.abort();
    controller = new AbortController();
    try {
      const res = await fetch(`${PHOTON_URL}&q=${encodeURIComponent(q)}`, { signal: controller.signal });
      results = (await res.json()).features ?? [];
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
