// Web Worker: builds 3D conformers with OpenChemLib off the main thread.
// The page starts a fresh worker for each molecule (see conformerJob in main.js).
import * as OCL from 'openchemlib';
import { makeConformer } from './conformer.js';

let ready = null;

self.onmessage = async ({ data }) => {
  const { id, molfile, seed, resources } = data;
  try {
    ready ??= OCL.Resources.registerFromUrl(resources);
    await ready;
    self.postMessage({ id, result: makeConformer(OCL, molfile, seed) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};
