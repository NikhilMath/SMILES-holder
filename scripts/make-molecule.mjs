#!/usr/bin/env node
// Command-line stick-model generator, handy for testing without the website.
//   node scripts/make-molecule.mjs "<SMILES>" [out.stl] [--stickBond=15 --stick=5 --hydrogens=false --pieces=two]
// Also writes out-assembled.stl and out.3mf (one part per element, for Bambu Studio / OrcaSlicer).
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'manifold-3d';
import * as OCL from 'openchemlib';
import { conformerFor, makeConformer } from '../src/core/conformer.js';
import { assignFilaments } from '../src/core/elements.js';
import { buildSticks, freeSticks, splitByElement, STICK_DEFAULTS } from '../src/core/sticks.js';
import { manifoldToSTL } from '../src/core/stl.js';
import { manifoldsTo3MF } from '../src/core/threemf.js';

const require = createRequire(import.meta.url);
const initRDKitModule = require('@rdkit/rdkit');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const [smiles, out = 'molecule.stl'] = positional;
if (!smiles) {
  console.error('usage: node scripts/make-molecule.mjs "<SMILES>" [out.stl] [--key=value ...]');
  process.exit(1);
}
const params = {};
for (const a of args.filter((x) => x.startsWith('--'))) {
  const [key, v = 'true'] = a.slice(2).split('=');
  const def = STICK_DEFAULTS[key];
  params[key] = typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? v === 'true' : v;
}

OCL.Resources.registerFromNodejs(); // reads resources.json next to openchemlib.js
const [RDKit, wasm] = await Promise.all([initRDKitModule(), Module()]);
wasm.setup();

const t0 = performance.now();
const mol3d = await conformerFor(RDKit, smiles, (molfile, seed) => makeConformer(OCL, molfile, seed));
const t1 = performance.now();
const built = buildSticks(wasm, mol3d, params);
const { plate, assembled, info } = built;
const t2 = performance.now();
const colours = assignFilaments(splitByElement(wasm, built));
const t3 = performance.now();

writeFileSync(out, manifoldToSTL(plate, 'Molecule stick model'));
writeFileSync(out.replace(/\.stl$/i, '-assembled.stl'), manifoldToSTL(assembled, 'Molecule stick model'));
writeFileSync(out.replace(/\.stl$/i, '.3mf'), await manifoldsTo3MF(
  colours.map((g) => ({ name: `${g.name} (${g.colourName})`, manifold: g.solid, filament: g.filament })),
  { name: 'Molecule stick model', center: [128, 128] },
));

console.log(JSON.stringify({
  conformer_ms: Math.round(t1 - t0),
  build_ms: Math.round(t2 - t1),
  colour_ms: Math.round(t3 - t2),
  colours: colours.map((g) => `${g.symbol}×${g.count}→${g.filament} ${g.solid.status()} ${(g.solid.volume() / 1000).toFixed(2)}cm³`),
  colour_volume_error: +(colours.reduce((v, g) => v + g.solid.volume(), 0) / plate.volume() - 1).toExponential(2),
  stereoOk: mol3d.stereoOk,
  note: mol3d.note,
  mode: info.mode,
  parts: info.parts,
  supports: info.supports,
  plate_mm: info.size.map((v) => +v.toFixed(1)),
  molecule_mm: info.moleculeSize.map((v) => +v.toFixed(1)),
  volume_cm3: +(info.volume / 1000).toFixed(1),
  status: plate.status(),
  tris: plate.numTri(),
}));
for (const g of colours) g.solid.delete();
freeSticks(built);
