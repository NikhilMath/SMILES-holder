// SMILES -> 3D molecule (atoms in Å, with hydrogens) for the stick model.
//
// RDKit.js has no 3D embedding, so OpenChemLib builds the conformer (torsion library +
// MMFF94s+ clean-up). Molecules are flexible, so it samples a few dozen likely conformers
// and keeps the flattest: chains then lie as a flat zigzag, which prints far better.
//
// OpenChemLib occasionally gets a stereocentre wrong: strained ring systems such as the
// propellane in modhephene with some seeds, and a cache that can carry a fragment over from
// an earlier molecule (atorvastatin, then gingerol). So every conformer is checked against
// RDKit's CIP labels for the input and regenerated with another seed when they differ, and
// the browser uses a fresh worker for each molecule.

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34];
const SAMPLES = 48;

/**
 * Builds one conformer. Runs in a Web Worker in the browser and directly in Node.
 * @param OCL      the openchemlib module (resources registered)
 * @param molfile  RDKit V2000 molblock (heavy atoms; OpenChemLib keeps their order and appends H)
 * @returns {{ molfile: string, atoms: {z:number, x:number, y:number, zc:number}[], bonds: {a:number, b:number, order:number}[], energy: number } | null}
 */
export function makeConformer(OCL, molfile, seed) {
  const gen = new OCL.ConformerGenerator(seed);
  let conf = null;
  if (gen.initializeConformers(OCL.Molecule.fromMolfile(molfile), {
    strategy: OCL.ConformerGenerator.STRATEGY_LIKELY_RANDOM,
    maxTorsionSets: 200,
  })) {
    let best = Infinity;
    for (let k = 0; k < SAMPLES; k++) {
      const c = gen.getNextConformerAsMolecule(null);
      if (!c) break;
      const f = flatness(c);
      if (f < best - 1e-3) { conf = c; best = f; }
    }
  }
  conf ??= new OCL.ConformerGenerator(seed).getOneConformerAsMolecule(OCL.Molecule.fromMolfile(molfile));
  if (!conf) return null;
  let energy = Number.NaN;
  try {
    const ff = new OCL.ForceFieldMMFF94(conf, 'MMFF94s+');
    ff.minimise({ maxIts: 3000 });
    energy = ff.getTotalEnergy();
  } catch {
    // MMFF has no parameters for some elements (B, Si, metals...): keep the raw conformer
  }
  const atoms = [];
  for (let i = 0; i < conf.getAllAtoms(); i++) {
    atoms.push({ z: conf.getAtomicNo(i), x: conf.getAtomX(i), y: conf.getAtomY(i), zc: conf.getAtomZ(i) });
  }
  const bonds = [];
  for (let b = 0; b < conf.getAllBonds(); b++) {
    bonds.push({ a: conf.getBondAtom(0, b), b: conf.getBondAtom(1, b), order: conf.getBondOrder(b) });
  }
  return { molfile: conf.toMolfile(), atoms, bonds, energy };
}

/**
 * The molblock to embed plus the stereo it has to reproduce.
 * Salts and mixtures keep only their largest fragment.
 */
export function prepareInput(RDKit, smiles) {
  let mol = RDKit.get_mol((smiles || '').trim());
  if (!mol || !mol.is_valid()) {
    mol?.delete?.();
    throw new Error('That SMILES could not be parsed.');
  }
  let fragmentNote = '';
  try {
    if (mol.get_smiles().includes('.')) {
      const largest = mol.get_smiles().split('.').reduce((best, s) => {
        const m = RDKit.get_mol(s);
        const n = m?.get_num_atoms() ?? 0;
        m?.delete();
        return n > best.n ? { s, n } : best;
      }, { s: '', n: -1 });
      mol.delete();
      mol = RDKit.get_mol(largest.s);
      fragmentNote = 'This is a salt or mixture, so only its largest part is shown.';
    }
    mol.set_new_coords(true);
    return { molfile: mol.get_molblock(), ...stereoTags(mol), fragmentNote };
  } finally {
    mol.delete();
  }
}

/** Does the 3D conformer have the R/S and E/Z labels the input asked for? */
export function stereoMatches(RDKit, input, molfile3D) {
  if (!input.atomTags.size && !input.bondTags.size) return true;
  const mol = RDKit.get_mol(molfile3D); // heavy atoms keep their indices, H come after them
  if (!mol || !mol.is_valid()) { mol?.delete?.(); return false; }
  try {
    const got = stereoTags(mol);
    for (const [i, label] of input.atomTags) if (got.atomTags.get(i) !== label) return false;
    for (const [pair, label] of input.bondTags) if (got.bondTags.get(pair) !== label) return false;
    return true;
  } finally {
    mol.delete();
  }
}

/**
 * Generates conformers until one has the right stereochemistry.
 * @param generate (molfile, seed) => conformer | null | Promise of one (makeConformer, or a worker call)
 * @returns {{ atoms, bonds, energy, stereoOk: boolean, note: string }}
 */
export async function conformerFor(RDKit, smiles, generate) {
  const input = prepareInput(RDKit, smiles);
  let fallback = null;
  for (const seed of SEEDS) {
    const conf = await generate(input.molfile, seed);
    if (!conf) continue;
    if (stereoMatches(RDKit, input, conf.molfile)) {
      return { ...conf, stereoOk: true, note: input.fragmentNote };
    }
    if (!fallback || conf.energy < fallback.energy) fallback = conf;
  }
  if (!fallback) throw new Error('Could not work out a 3D shape for this molecule.');
  return { ...fallback, stereoOk: false, note: [input.fragmentNote, 'Some stereocentres may be flipped in this 3D model.'].filter(Boolean).join(' ') };
}

// CIP labels the input actually specifies; "(?)" marks a stereocentre left open.
function stereoTags(mol) {
  const tags = JSON.parse(mol.get_stereo_tags());
  const defined = (label) => !label.includes('?');
  return {
    atomTags: new Map((tags.CIP_atoms ?? []).filter(([, l]) => defined(l))),
    bondTags: new Map((tags.CIP_bonds ?? []).filter(([, , l]) => defined(l))
      .map(([a, b, l]) => [`${Math.min(a, b)}-${Math.max(a, b)}`, l])),
  };
}

// RMS distance of the heavy atoms from their best-fit plane, in Å.
function flatness(mol) {
  const P = [];
  for (let i = 0; i < mol.getAllAtoms(); i++) {
    if (mol.getAtomicNo(i) > 1) P.push([mol.getAtomX(i), mol.getAtomY(i), mol.getAtomZ(i)]);
  }
  if (P.length < 4) return 0;
  const c = [0, 1, 2].map((k) => P.reduce((s, q) => s + q[k], 0) / P.length);
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of P) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += (q[a] - c[a]) * (q[b] - c[b]);
  // Smallest eigenvalue of C: power iteration on (trace·I − C)
  const tr = C[0][0] + C[1][1] + C[2][2];
  let v = [0.31, 0.53, 0.79];
  for (let it = 0; it < 60; it++) {
    const w = [0, 1, 2].map((a) => tr * v[a] - (C[a][0] * v[0] + C[a][1] * v[1] + C[a][2] * v[2]));
    const l = Math.hypot(...w);
    if (l < 1e-12) break;
    v = w.map((x) => x / l);
  }
  const Cv = [0, 1, 2].map((a) => C[a][0] * v[0] + C[a][1] * v[1] + C[a][2] * v[2]);
  return Math.sqrt(Math.max(0, Cv[0] * v[0] + Cv[1] * v[1] + Cv[2] * v[2]) / P.length);
}
