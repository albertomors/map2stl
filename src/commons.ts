// Openly licensed 3D models of a landmark on Wikimedia Commons (STL files, CC0 or CC BY and
// the like), most precise first: the one its Wikidata item names as its 3D model, then
// Commons files marked as depicting it, then a search by its name. No key needed. The
// license and author come along, for the panel and for the credit in the export.

const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
// Big scans are slow to download and heavy to print: offer them, but not huge ones.
const MAX_BYTES = 60e6;
const NAME_RESULTS = 8;

export interface CommonsModel {
  // "File:Gateway Arch.stl"
  title: string;
  name: string;
  url: string;
  pageUrl: string;
  bytes: number;
  license: string;
  author: string;
  // How it was found: its Wikidata item's own model, a file depicting it, or a name match.
  match: 'wikidata' | 'depicts' | 'name';
}

// `town`: searched with the name, when there's no Wikidata item to go by (a local name alone
// can match a namesake elsewhere).
export async function findCommonsModels(landmark: { wikidata?: string; name?: string; town?: string }, signal: AbortSignal): Promise<CommonsModel[]> {
  const found = new Map<string, CommonsModel['match']>();
  const add = (titles: string[], match: CommonsModel['match']) => titles.forEach((t) => found.has(t) || found.set(t, match));
  if (landmark.wikidata) {
    add(await wikidataModels(landmark.wikidata, signal), 'wikidata');
    add(await searchFiles(`haswbstatement:P180=${landmark.wikidata}`, signal), 'depicts');
  }
  if (landmark.name) {
    const town = landmark.town && !landmark.name.includes(landmark.town) ? ` ${landmark.town.replace(/"/g, '')}` : '';
    add((await searchFiles(`"${landmark.name.replace(/"/g, '')}"${town}`, signal)).slice(0, NAME_RESULTS), 'name');
  }
  if (!found.size) return [];
  const info = await fileInfo([...found.keys()], signal);
  return info
    .filter((m) => m.bytes <= MAX_BYTES)
    .map((m) => ({ ...m, match: found.get(m.title)! }))
    .sort((a, b) => order(a.match) - order(b.match));
}

const order = (m: CommonsModel['match']) => ['wikidata', 'depicts', 'name'].indexOf(m);

// The item's English name: OSM names are local ("Torre di Pisa"), and model sites are
// searched mostly in English ("Leaning Tower of Pisa" finds three times as many).
export async function wikidataEnglishName(item: string, signal: AbortSignal): Promise<string | undefined> {
  const json = await get(WIKIDATA_API, { action: 'wbgetentities', ids: item, props: 'labels', languages: 'en' }, signal);
  return json.entities?.[item]?.labels?.en?.value;
}

// The item's "3D model" statements (P4896), as Commons file titles.
async function wikidataModels(item: string, signal: AbortSignal): Promise<string[]> {
  const json = await get(WIKIDATA_API, { action: 'wbgetclaims', entity: item, property: 'P4896' }, signal);
  const claims: { mainsnak?: { datavalue?: { value?: string } } }[] = json.claims?.P4896 ?? [];
  return claims.flatMap((c) => (c.mainsnak?.datavalue?.value ? [`File:${c.mainsnak.datavalue.value}`] : []));
}

// STL files on Commons matching a search.
async function searchFiles(query: string, signal: AbortSignal): Promise<string[]> {
  const json = await get(COMMONS_API, { action: 'query', list: 'search', srsearch: `${query} filemime:application/sla`, srnamespace: '6', srlimit: '20' }, signal);
  return (json.query?.search ?? []).map((r: { title: string }) => r.title);
}

interface ExtMeta {
  value: string;
}

async function fileInfo(titles: string[], signal: AbortSignal): Promise<Omit<CommonsModel, 'match'>[]> {
  const json = await get(
    COMMONS_API,
    {
      action: 'query',
      titles: titles.slice(0, 50).join('|'),
      prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata',
      iiextmetadatafilter: 'LicenseShortName|Artist|ObjectName',
    },
    signal,
  );
  const pages: { title: string; imageinfo?: { url: string; descriptionurl: string; size: number; mime: string; extmetadata?: Record<string, ExtMeta> }[] }[] = Object.values(
    json.query?.pages ?? {},
  );
  return pages.flatMap((p) => {
    const ii = p.imageinfo?.[0];
    if (!ii || ii.mime !== 'application/sla') return [];
    const meta = ii.extmetadata ?? {};
    return [
      {
        title: p.title,
        name: plain(meta.ObjectName?.value) || p.title.replace(/^File:/, '').replace(/\.stl$/i, ''),
        url: ii.url,
        pageUrl: ii.descriptionurl,
        bytes: ii.size,
        license: plain(meta.LicenseShortName?.value) || 'see the file page',
        author: plain(meta.Artist?.value) || 'unknown',
      },
    ];
  });
}

async function get(api: string, params: Record<string, string>, signal: AbortSignal) {
  // origin=* lets a browser page read the answer (anonymous requests).
  const url = `${api}?${new URLSearchParams({ ...params, format: 'json', formatversion: '1', origin: '*' })}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Wikimedia answered ${res.status}`);
  return res.json();
}

// The text of a bit of HTML (Commons gives authors as links).
function plain(html: string | undefined): string {
  if (!html) return '';
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim().replace(/\s+/g, ' ') ?? '';
}
