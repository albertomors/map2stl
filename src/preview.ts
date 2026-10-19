// Shows the fetched data on the map, one toggleable layer per category, so the selection's
// contents can be checked before the 3D viewer exists. Buildings are extruded with the
// heights the model will use; the base map's own buildings are hidden meanwhile.

import type { ExpressionSpecification, Map } from 'maplibre-gl';
import type { AreaData, Layer } from './area-data';
import type { Area, Line, Polygon } from './osm';

export const LAYER_COLORS: Record<Layer, string> = {
  buildings: '#d0764f',
  structures: '#b8487a',
  roads: '#4a4f5a',
  railways: '#8a5cc2',
  paved: '#9aa1ab',
  water: '#3b8fe0',
  green: '#5fae4c',
  surfaces: '#d9be7c',
  trees: '#2e7a2e',
};

// Drawn below the selection outline, bottom to top.
const POLYGONS: ExpressionSpecification = ['==', ['geometry-type'], 'Polygon'];
const LINES: ExpressionSpecification = ['==', ['geometry-type'], 'LineString'];
const POINTS: ExpressionSpecification = ['==', ['geometry-type'], 'Point'];
const LAYERS: { layer: Layer; id: string; type: 'fill' | 'line' | 'circle' | 'fill-extrusion'; filter?: ExpressionSpecification }[] = [
  { layer: 'green', id: 'preview-green', type: 'fill' },
  { layer: 'surfaces', id: 'preview-surfaces', type: 'fill' },
  { layer: 'water', id: 'preview-water-areas', type: 'fill', filter: POLYGONS },
  { layer: 'water', id: 'preview-waterways', type: 'line', filter: LINES },
  { layer: 'paved', id: 'preview-paved-areas', type: 'fill', filter: POLYGONS },
  { layer: 'paved', id: 'preview-paved-lines', type: 'line', filter: LINES },
  { layer: 'roads', id: 'preview-roads', type: 'line' },
  { layer: 'railways', id: 'preview-railways', type: 'line' },
  { layer: 'trees', id: 'preview-trees', type: 'circle' },
  { layer: 'structures', id: 'preview-structure-lines', type: 'line', filter: LINES },
  { layer: 'structures', id: 'preview-structure-areas', type: 'fill-extrusion', filter: POLYGONS },
  { layer: 'structures', id: 'preview-towers', type: 'circle', filter: POINTS },
  { layer: 'buildings', id: 'preview-buildings', type: 'fill-extrusion' },
];

const TREE_RADIUS_M = 3;
const TOWER_RADIUS_M = 4;

export class DataPreview {
  private hiddenBaseLayers: string[] = [];

  constructor(private map: Map, private beforeId: string) {}

  show(data: AreaData) {
    this.clear();
    const { osm } = data;
    const sources: Record<Layer, GeoJSON.Feature[]> = {
      buildings: osm.buildings.map((b) => polygon(b, { height: b.height, base: b.minHeight })),
      roads: osm.roads.map(line),
      railways: osm.railways.map(line),
      water: [...osm.waterAreas.map((a) => area(a)), ...osm.waterways.map(line)],
      green: osm.green.map((a) => area(a)),
      surfaces: osm.surfaces.map((a) => area(a)),
      paved: [...osm.pavedAreas.map((a) => area(a)), ...osm.pavedLines.map(line)],
      structures: [
        ...osm.structureAreas.map((a) => polygon(a, { kind: a.kind, height: a.height, base: 0 })),
        ...osm.structureLines.map(line),
        ...osm.towers.map((t) => point(t.at, { kind: t.kind })),
      ],
      trees: osm.trees.map((p) => point(p, {})),
    };
    for (const [layer, features] of Object.entries(sources)) {
      this.map.addSource(`preview-${layer}`, { type: 'geojson', data: { type: 'FeatureCollection', features } });
    }

    // Line widths are in meters: convert to pixels for the zoom, at this latitude.
    const metersToPx = (meters: ExpressionSpecification | number): ExpressionSpecification => {
      const pxPerMeterAtZ0 = 1 / (156543.03 * Math.cos((data.selection.center[1] * Math.PI) / 180));
      return ['interpolate', ['exponential', 2], ['zoom'], 0, ['*', meters, pxPerMeterAtZ0], 22, ['*', meters, pxPerMeterAtZ0 * 2 ** 22]];
    };

    for (const { layer, id, type, filter } of LAYERS) {
      const color = LAYER_COLORS[layer];
      const common = { id, source: `preview-${layer}`, ...(filter ? { filter } : {}) };
      if (type === 'fill') {
        this.map.addLayer({ ...common, type, paint: { 'fill-color': color, 'fill-opacity': 0.55 } }, this.beforeId);
      } else if (type === 'line') {
        // Bridges in a darker shade, so they can be told apart from the street below.
        const lineColor: ExpressionSpecification = ['case', ['==', ['get', 'bridge'], 1], '#1b1d22', color];
        const paint = { 'line-color': lineColor, 'line-width': metersToPx(['get', 'width']) };
        this.map.addLayer({ ...common, type, paint, layout: { 'line-cap': 'round', 'line-join': 'round' } }, this.beforeId);
      } else if (type === 'circle') {
        const radius = layer === 'trees' ? TREE_RADIUS_M : TOWER_RADIUS_M;
        this.map.addLayer({ ...common, type, paint: { 'circle-color': color, 'circle-radius': metersToPx(radius) } }, this.beforeId);
      } else {
        const paint = {
          'fill-extrusion-color': color,
          'fill-extrusion-height': ['get', 'height'] as ExpressionSpecification,
          'fill-extrusion-base': ['get', 'base'] as ExpressionSpecification,
          'fill-extrusion-opacity': 0.9,
        };
        this.map.addLayer({ ...common, type, paint }, this.beforeId);
      }
    }

    // The base map draws its own buildings in the same places.
    for (const l of this.map.getStyle().layers) {
      if ('source-layer' in l && l['source-layer'] === 'building' && this.map.getLayoutProperty(l.id, 'visibility') !== 'none') {
        this.map.setLayoutProperty(l.id, 'visibility', 'none');
        this.hiddenBaseLayers.push(l.id);
      }
    }
  }

  setVisible(layer: Layer, visible: boolean) {
    for (const l of LAYERS) {
      if (l.layer === layer && this.map.getLayer(l.id)) this.map.setLayoutProperty(l.id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  clear() {
    for (const { id } of LAYERS) if (this.map.getLayer(id)) this.map.removeLayer(id);
    for (const layer of Object.keys(LAYER_COLORS)) {
      if (this.map.getSource(`preview-${layer}`)) this.map.removeSource(`preview-${layer}`);
    }
    for (const id of this.hiddenBaseLayers) this.map.setLayoutProperty(id, 'visibility', 'visible');
    this.hiddenBaseLayers = [];
  }
}

function polygon(p: Polygon, properties: Record<string, number | string>): GeoJSON.Feature {
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [p.outer, ...p.holes] } };
}

function area(a: Area): GeoJSON.Feature {
  return polygon(a, { kind: a.kind });
}

function point(p: [number, number], properties: Record<string, number | string>): GeoJSON.Feature {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: p } };
}

function line(l: Line): GeoJSON.Feature {
  return { type: 'Feature', properties: { kind: l.kind, width: l.width, bridge: l.bridge ? 1 : 0 }, geometry: { type: 'LineString', coordinates: l.path } };
}

