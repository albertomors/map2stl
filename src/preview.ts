// Shows the fetched data on the map, one toggleable layer per category, so the selection's
// contents can be checked before the 3D viewer exists. Buildings are extruded with the
// heights the model will use; the base map's own buildings are hidden meanwhile.

import type { ExpressionSpecification, Map } from 'maplibre-gl';
import type { AreaData, Layer } from './area-data';
import type { Area, Line, Polygon } from './osm';

export const LAYER_COLORS: Record<Layer, string> = {
  buildings: '#d0764f',
  roads: '#4a4f5a',
  railways: '#8a5cc2',
  water: '#3b8fe0',
  green: '#5fae4c',
  trees: '#2e7a2e',
};

// Drawn below the selection outline, bottom to top.
const LAYERS: { layer: Layer; id: string; type: 'fill' | 'line' | 'circle' | 'fill-extrusion'; filter?: ExpressionSpecification }[] = [
  { layer: 'green', id: 'preview-green', type: 'fill' },
  { layer: 'water', id: 'preview-water-areas', type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'] },
  { layer: 'water', id: 'preview-waterways', type: 'line', filter: ['==', ['geometry-type'], 'LineString'] },
  { layer: 'roads', id: 'preview-roads', type: 'line' },
  { layer: 'railways', id: 'preview-railways', type: 'line' },
  { layer: 'trees', id: 'preview-trees', type: 'circle' },
  { layer: 'buildings', id: 'preview-buildings', type: 'fill-extrusion' },
];

const TREE_RADIUS_M = 3;

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
      trees: osm.trees.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })),
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
        const paint = { 'line-color': color, 'line-width': metersToPx(['get', 'width']) };
        this.map.addLayer({ ...common, type, paint, layout: { 'line-cap': 'round', 'line-join': 'round' } }, this.beforeId);
      } else if (type === 'circle') {
        this.map.addLayer({ ...common, type, paint: { 'circle-color': color, 'circle-radius': metersToPx(TREE_RADIUS_M) } }, this.beforeId);
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

function line(l: Line): GeoJSON.Feature {
  return { type: 'Feature', properties: { kind: l.kind, width: l.width }, geometry: { type: 'LineString', coordinates: l.path } };
}

