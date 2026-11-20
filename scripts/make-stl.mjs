#!/usr/bin/env node
// Command-line generator, handy for testing the geometry without the website.
//   node scripts/make-stl.mjs "<SMILES>" [out.stl] [--bondLength=22 --height=80 ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Module from 'manifold-3d';
import { Font } from 'three/addons/loaders/FontLoader.js';
import { smilesToMolecule } from '../src/core/molecule.js';
import { buildPenholder, DEFAULTS } from '../src/core/penholder.js';
import { manifoldToSTL } from '../src/core/stl.js';
import { manifoldsTo3MF } from '../src/core/threemf.js';

const require = createRequire(import.meta.url);
const initRDKitModule = require('@rdkit/rdkit');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [smiles, out = 'penholder.stl'] = positional;
if (!smiles) {
  console.error('usage: node scripts/make-stl.mjs "<SMILES>" [out.stl] [--key=value ...]');
  process.exit(1);
}
const params = {};
for (const a of args.filter((x) => x.startsWith('--'))) {
  const [k, v = 'true'] = a.slice(2).split('=');
  const def = DEFAULTS[k];
  params[k] = typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? v === 'true' : v;
}

const fontPath = fileURLToPath(new URL('../src/assets/fonts/droid_sans_bold.typeface.json', import.meta.url));
const font = new Font(JSON.parse(readFileSync(fontPath, 'utf8')));
const [RDKit, wasm] = await Promise.all([initRDKitModule(), Module()]);
wasm.setup();

const t0 = performance.now();
const molecule = smilesToMolecule(RDKit, smiles);
const { body, accent, info } = buildPenholder(wasm, font, molecule, params);
const combined = wasm.Manifold.union(body, accent);
const ms = performance.now() - t0;

writeFileSync(out, manifoldToSTL(combined));
const base = out.replace(/\.stl$/i, '');
writeFileSync(`${base}-body.stl`, manifoldToSTL(body));
writeFileSync(`${base}-accent.stl`, manifoldToSTL(accent));
writeFileSync(`${base}.3mf`, await manifoldsTo3MF([
  { name: 'Body', manifold: body, filament: 1 },
  { name: 'Top layer', manifold: accent, filament: 2 },
], { name: 'Pen holder', center: [128, 128] }));

console.log(JSON.stringify({
  ms: Math.round(ms),
  size_mm: info.size.map((v) => +v.toFixed(1)),
  volume_cm3: +(info.volume / 1000).toFixed(1),
  cells_mm: info.cells.map((v) => +v.toFixed(1)),
  status: { body: body.status(), accent: accent.status(), combined: combined.status() },
  genus: combined.genus(),
  parts: combined.decompose().length,
  tris: combined.numTri(),
}, null, 1));
