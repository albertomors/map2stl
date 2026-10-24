// File formats for the print model: binary STL (one solid, what every slicer reads) and 3MF
// (one object made of a named, colored part per layer, for multi-color printing). Both carry the
// OpenStreetMap credit the ODbL license requires.

import { strToU8, zipSync } from 'fflate';
import type { PrintModel } from './export';

const CREDIT = 'Map data (c) OpenStreetMap contributors, ODbL. Made with map2stl.';

export function toSTL(model: PrintModel): Blob {
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
  return new Blob([buffer], { type: 'model/stl' });
}

// `credits`: for 3D models used in place of buildings (their licenses ask for it).
export function to3MF(model: PrintModel, title: string, credits: string[] = []): Blob {
  const objects: string[] = [];
  const items: string[] = [];
  const bases: string[] = [];
  model.parts.forEach((part, i) => {
    bases.push(`<base name="${xml(part.name)}" displaycolor="${part.color.toUpperCase()}FF"/>`);
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
    const id = i + 2;
    objects.push(
      `<object id="${id}" name="${xml(part.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object>`,
    );
    items.push(`<component objectid="${id}"/>`);
  });
  // One object holding every part as a component: slicers load it as a single model with
  // parts that stay aligned, instead of asking whether these separate objects belong together.
  const assemblyId = model.parts.length + 2;
  objects.push(`<object id="${assemblyId}" name="${xml(title)}" type="model"><components>${items.join('')}</components></object>`);
  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    `<metadata name="Title">${xml(title)}</metadata>` +
    `<metadata name="Copyright">${xml(['© OpenStreetMap contributors (ODbL)', ...credits].join('; '))}</metadata>` +
    (credits.length ? `<metadata name="LicenseTerms">${xml(credits.join('; '))}</metadata>` : '') +
    `<metadata name="Application">map2stl</metadata>` +
    `<resources><basematerials id="1">${bases.join('')}</basematerials>${objects.join('')}</resources>` +
    `<build><item objectid="${assemblyId}"/></build></model>`;
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
  // other slicers ignore it. Part i gets filament i + 1, so with one filament per part loaded
  // the colors are ready; on a single-filament printer they fall back to filament 1.
  const settings =
    `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n` +
    `  <object id="${assemblyId}">\n` +
    `    <metadata key="name" value="${xml(title)}"/>\n` +
    `    <metadata key="extruder" value="1"/>\n` +
    model.parts
      .map(
        (part, i) =>
          `    <part id="${i + 2}" subtype="normal_part">\n` +
          `      <metadata key="name" value="${xml(part.name)}"/>\n` +
          `      <metadata key="extruder" value="${i + 1}"/>\n` +
          `    </part>\n`,
      )
      .join('') +
    `  </object>\n</config>\n`;
  const zip = zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(settings),
  });
  return new Blob([zip as BlobPart], { type: 'model/3mf' });
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
