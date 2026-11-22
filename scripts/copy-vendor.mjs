// Copies RDKit's browser build into public/ so it is served as a plain script + wasm file,
// and OpenChemLib's data tables (torsion library + MMFF94) for the stick-model conformers.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const rdkitDir = dirname(require.resolve('@rdkit/rdkit'));
const rdkitDest = join(root, 'public', 'vendor', 'rdkit');
mkdirSync(rdkitDest, { recursive: true });
for (const f of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) copyFileSync(join(rdkitDir, f), join(rdkitDest, f));
console.log('copied RDKit to public/vendor/rdkit');

// Only the tables the conformer generator and force field read (skips drug-likeness and toxicity data)
const oclResources = JSON.parse(readFileSync(join(dirname(require.resolve('openchemlib')), 'resources.json'), 'utf8'));
const needed = Object.fromEntries(Object.entries(oclResources).filter(([k]) => /^\/resources\/(cod|forcefield)\//.test(k)));
const oclDest = join(root, 'public', 'vendor', 'openchemlib');
mkdirSync(oclDest, { recursive: true });
writeFileSync(join(oclDest, 'resources.json'), JSON.stringify(needed));
console.log('wrote OpenChemLib resources to public/vendor/openchemlib');
