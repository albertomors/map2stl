// File formats for the print model: binary STL (one solid, what every slicer reads) and 3MF
// (one object made of a named, colored part per layer, for multi-color printing). Both carry the
// OpenStreetMap credit the ODbL license requires. Printed in pieces (pieces.ts): a zip of one
// STL per piece, or one 3MF with an object per piece.

import { strToU8, zipSync } from 'fflate';
import type { PrintModel } from './export';

const CREDIT = 'Map data (c) OpenStreetMap contributors, ODbL. Made with map2stl.';

export function toSTL(model: PrintModel): Blob {
  return new Blob([stlBytes(model)], { type: 'model/stl' });
}

// Each piece's STL, named by its row and column, in one zip.
export function toSTLPieces(pieces: { name: string; model: PrintModel }[]): Blob {
  const files = Object.fromEntries(pieces.map(({ name, model }) => [`${name}.stl`, new Uint8Array(stlBytes(model))]));
  return new Blob([zipSync(files) as BlobPart], { type: 'application/zip' });
}

function stlBytes(model: PrintModel): ArrayBuffer {
  const count = model.triangleCount;
  const buffer = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buffer);
  // 80-byte ASCII header. It must not start with "solid", or some readers take it for text STL.
  const header = strToU8(CREDIT.slice(0, 80));
  new Uint8Array(buffer, 0, 80).set(header);
  view.setUint32(80, count, true);
  let o = 84;
  for (const part of model.parts) {
    const t = part.triangles;
    for (let i = 0; i < t.length; i += 9) {
      // Facet normal from the winding (slicers recompute it, but some viewers use it).
      const ux = t[i + 3] - t[i], uy = t[i + 4] - t[i + 1], uz = t[i + 5] - t[i + 2];
      const vx = t[i + 6] - t[i], vy = t[i + 7] - t[i + 1], vz = t[i + 8] - t[i + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
      for (let k = 0; k < 9; k++) { view.setFloat32(o, t[i + k], true); o += 4; }
      view.setUint16(o, 0, true);
      o += 2;
    }
  }
  return buffer;
}

// `credits`: for 3D models used in place of buildings (their licenses ask for it).
export function to3MF(model: PrintModel, title: string, credits: string[] = []): Blob {
  return to3MFPieces([{ name: title, model, offset: [0, 0] }], title, credits);
}

// One object per piece, each made of its colored parts, laid out `offset` apart (mm).
export function to3MFPieces(pieces: { name: string; model: PrintModel; offset: [number, number] }[], title: string, credits: string[] = []): Blob {
  const objects: string[] = [];
  const build: string[] = [];
  const settings: string[] = [];
  // One color per kind of part, the same in every piece (filament i + 1 for kind i).
  const kinds: { name: string; color: string }[] = [];
  const kindOf = (name: string, color: string) => {
    let k = kinds.findIndex((x) => x.name === name);
    if (k < 0) k = kinds.push({ name, color }) - 1;
    return k;
  };
  let nextId = 2;
  for (const piece of pieces) {
    const items: string[] = [];
    const partSettings: string[] = [];
    for (const part of piece.model.parts) {
      const kind = kindOf(part.name, part.color);
      const id = nextId++;
      objects.push(objectXml(part, id, kind));
      items.push(`<component objectid="${id}"/>`);
      partSettings.push(
        `    <part id="${id}" subtype="normal_part">\n` +
          `      <metadata key="name" value="${xml(part.name)}"/>\n` +
          `      <metadata key="extruder" value="${kind + 1}"/>\n` +
          `    </part>\n`,
      );
    }
    if (!items.length) continue;
    // One object holding every part as a component: slicers load it as a single model with
    // parts that stay aligned, instead of asking whether these separate objects belong together.
    const assemblyId = nextId++;
    objects.push(`<object id="${assemblyId}" name="${xml(piece.name)}" type="model"><components>${items.join('')}</components></object>`);
    const [dx, dy] = piece.offset;
    build.push(`<item objectid="${assemblyId}"${dx || dy ? ` transform="1 0 0 0 1 0 0 0 1 ${dx.toFixed(3)} ${dy.toFixed(3)} 0"` : ''}/>`);
    settings.push(
      `  <object id="${assemblyId}">\n` +
        `    <metadata key="name" value="${xml(piece.name)}"/>\n` +
        `    <metadata key="extruder" value="1"/>\n` +
        partSettings.join('') +
        `  </object>\n`,
    );
  }
  const bases = kinds.map((k) => `<base name="${xml(k.name)}" displaycolor="${k.color.toUpperCase()}FF"/>`);
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xml(title)}</metadata>` +
    `<metadata name="Copyright">${xml(['© OpenStreetMap contributors (ODbL)', ...credits].join('; '))}</metadata>` +
    (credits.length ? `<metadata name="LicenseTerms">${xml(credits.join('; '))}</metadata>` : '') +
    `<metadata name="Application">map2stl</metadata>` +
    `<resources><basematerials id="1">${bases.join('')}</basematerials>${objects.join('')}</resources>` +
    `<build>${build.join('')}</build></model>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`;
  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`;
  // OrcaSlicer and Bambu Studio read part names and filaments from their own settings file;
  // other slicers ignore it. Each kind of part gets its own filament, so with one filament
  // per kind loaded the colors are ready; on a single-filament printer they fall back to 1.
  const config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${settings.join('')}</config>\n`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(config),
  });
  return new Blob([zip as BlobPart], { type: 'model/3mf' });
}

// A part as a 3MF mesh object, colored as its kind.
function objectXml(part: PrintModel['parts'][number], id: number, kind: number): string {
  // Shared vertices: 3MF lists each point once and triangles refer to them by index. Only
  // within one solid: two houses touching along a wall must not share points, or slicers see
  // the shared edge (four faces) as broken.
  const index = new Map<string, number>();
  const vertices: string[] = [];
  const triangles: string[] = [];
  const t = part.triangles;
  const vertex = (k: number) => {
    // Exact positions: the meshes are built with shared corners computed once, so equal means
    // the same point. Rounding would fuse distinct points a hair apart and fold the tiny
    // triangles between them.
    const key = `${part.solids[(k / 9) | 0]} ${t[k]} ${t[k + 1]} ${t[k + 2]}`;
    let id = index.get(key);
    if (id === undefined) {
      id = vertices.length;
      index.set(key, id);
      vertices.push(`<vertex x="${t[k].toFixed(3)}" y="${t[k + 1].toFixed(3)}" z="${t[k + 2].toFixed(3)}"/>`);
    }
    return id;
  };
  for (let k = 0; k < t.length; k += 9) {
    const a = vertex(k), b = vertex(k + 3), c = vertex(k + 6);
    // Triangles squashed to a line or point by the vertex merge are dropped.
    if (a !== b && b !== c && a !== c) triangles.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  }
  return `<object id="${id}" name="${xml(part.name)}" type="model" pid="1" pindex="${kind}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
