// The 3D models standing in for buildings (see viewer/models.ts): what one is, where it came
// from, and the ones loaded in this page. Kept free of three.js, so the page can hold models
// without loading the 3D code.

export type Axis = 'x' | 'y' | 'z';

// Where a model came from, for the panel and for the credit in the export.
export interface ModelSource {
  kind: 'upload' | 'commons' | 'sketchfab';
  title: string;
  url?: string;
  license?: string;
  author?: string;
}

export interface ModelAsset {
  id: string;
  // Triangles as they came from the file, 9 floats each, in its own units and axes.
  triangles: Float32Array;
  // The file's likely up axis (STL is usually Z-up, glTF and OBJ Y-up).
  up: Axis;
  source: ModelSource;
}

// What a building's edit says about its model.
export interface ModelChoice {
  asset: string;
  up: Axis;
  // Quarter turns on top of the automatic alignment.
  turns: number;
}

// The models loaded in this page (or sent along to the print worker), by id.
export const modelAssets = new Map<string, ModelAsset>();
