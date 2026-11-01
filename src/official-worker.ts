// Reads official 3D buildings off the main thread (see official3d.ts): a city center is
// hundreds of tiles, which would freeze the page and, read all at once, run it out of memory.

import { loadOfficialModels, type OfficialJob, type OfficialMessage } from './official3d';

self.onmessage = async (e: MessageEvent<OfficialJob>) => {
  const post = (m: OfficialMessage, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(m, transfer);
  try {
    await loadOfficialModels(e.data, post);
  } catch (err) {
    post({ type: 'error', message: (err as Error).message });
  }
};
