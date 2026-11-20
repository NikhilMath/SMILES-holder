// SMILES -> 2D molecule graph (atoms with coordinates, bonds with orders/wedges, rings).
// Works in the browser and in Node; pass in an initialised RDKit MinimalLib module.

export const MAX_HEAVY_ATOMS = 120;

/**
 * @returns {{
 *   atoms: {sym:string, z:number, hs:number, charge:number, x:number, y:number}[],
 *   bonds: {a:number, b:number, order:number, stereo:null|'wedge'|'hash', from:number}[],
 *   rings: number[][],
 *   canonicalSmiles: string,
 * }}
 */
export function smilesToMolecule(RDKit, smiles) {
  const input = (smiles || '').trim();
  if (!input) throw new Error('Type a SMILES string to get started.');
  const mol = RDKit.get_mol(input);
  if (!mol || !mol.is_valid()) {
    mol?.delete?.();
    throw new Error('That SMILES could not be parsed. Check brackets, ring numbers and atom symbols.');
  }
  try {
    const n = mol.get_num_atoms(true);
    if (n > MAX_HEAVY_ATOMS) {
      throw new Error(`That molecule has ${n} heavy atoms — too big for a pen holder (max ${MAX_HEAVY_ATOMS}).`);
    }
    mol.set_new_coords(true); // CoordGen: nicer ring systems & macrocycles
    try { mol.straighten_depiction(); } catch { /* older RDKit builds */ }

    const root = JSON.parse(mol.get_json());
    const defs = root.defaults ?? { atom: {}, bond: {} };
    const jm = root.molecules[0];
    const coords = jm.conformers?.[0]?.coords ?? [];
    const ext = (jm.extensions ?? []).find((e) => e.name === 'rdkitRepresentation') ?? {};

    const { symbols, wedges } = parseMolblock(mol.get_molblock());

    const atoms = jm.atoms.map((a, i) => {
      const at = { ...defs.atom, ...a };
      return {
        sym: symbols[i] ?? 'C',
        z: at.z,
        hs: at.impHs ?? 0,
        charge: at.chg ?? 0,
        x: coords[i]?.[0] ?? 0,
        y: coords[i]?.[1] ?? 0,
      };
    });

    const bonds = (jm.bonds ?? []).map((b) => {
      const bd = { ...defs.bond, ...b };
      const [a, c] = bd.atoms;
      const w = wedges.get(key(a, c));
      return {
        a,
        b: c,
        order: bd.bo === 2 || bd.bo === 3 ? bd.bo : 1,
        stereo: w?.stereo ?? null,
        from: w?.from ?? a,
      };
    });

    return {
      atoms,
      bonds,
      rings: ext.atomRings ?? [],
      canonicalSmiles: mol.get_smiles(),
    };
  } finally {
    mol.delete();
  }
}

/** Render a small 2D drawing with RDKit (same depiction RDKit uses for the layout). */
export function smilesToSvg(RDKit, smiles, width = 320, height = 220) {
  const mol = RDKit.get_mol((smiles || '').trim());
  if (!mol || !mol.is_valid()) { mol?.delete?.(); return ''; }
  try {
    mol.set_new_coords(true);
    try { mol.straighten_depiction(); } catch { /* ignore */ }
    return mol.get_svg_with_highlights(JSON.stringify({
      width, height,
      bondLineWidth: 1.6,
      clearBackground: false,
      padding: 0.08,
    }));
  } finally {
    mol.delete();
  }
}

const key = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

// Pull element symbols and wedge/hash bond info out of a V2000 molblock.
function parseMolblock(mb) {
  const lines = mb.split('\n');
  const symbols = [];
  const wedges = new Map();
  const counts = lines[3] ?? '';
  if (!counts.includes('V2000')) return { symbols, wedges };
  const nA = parseInt(counts.slice(0, 3), 10);
  const nB = parseInt(counts.slice(3, 6), 10);
  for (let i = 0; i < nA; i++) {
    symbols.push(lines[4 + i].slice(31, 34).trim());
  }
  for (let i = 0; i < nB; i++) {
    const l = lines[4 + nA + i];
    const a1 = parseInt(l.slice(0, 3), 10) - 1;
    const a2 = parseInt(l.slice(3, 6), 10) - 1;
    const st = parseInt(l.slice(9, 12), 10);
    if (st === 1 || st === 6) {
      wedges.set(key(a1, a2), { stereo: st === 1 ? 'wedge' : 'hash', from: a1 });
    }
  }
  return { symbols, wedges };
}
