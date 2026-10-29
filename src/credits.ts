// Who to credit for a model built from an area: the sources whose licenses ask for it,
// besides OpenStreetMap (always). Written into 3MF and glTF files and shown after a download.

import type { AreaData, Layer } from './area-data';
import type { ModelAsset } from './model-assets';
import { isSea } from './osm';

export function sourceCredits(data: AreaData, models: ModelAsset[], visible: Layer[]): string[] {
  // Models found online came with a license asking for credit.
  // Once each: official models come one per building, all with the same credit.
  const credits = [...new Set(models.flatMap((m) => (m.source.kind !== 'upload' ? [`3D model "${m.source.title}" by ${m.source.author}, ${m.source.license}, ${m.source.url}`] : [])))];
  // So did the sea floor (shown only with water off).
  if (data.bathymetry && !visible.includes('water') && data.osm.waterAreas.some(isSea)) credits.push(data.bathymetry.source.credit);
  return credits;
}
