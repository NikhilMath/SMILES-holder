// Copies RDKit's browser build into public/ so it is served as a plain script + wasm file.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rdkitDir = dirname(require.resolve('@rdkit/rdkit'));
const dest = join(root, 'public', 'vendor', 'rdkit');
mkdirSync(dest, { recursive: true });
for (const f of ['RDKit_minimal.js', 'RDKit_minimal.wasm']) copyFileSync(join(rdkitDir, f), join(dest, f));
console.log('copied RDKit to public/vendor/rdkit');
