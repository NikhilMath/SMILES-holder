// Element names and the usual model-kit colours (CPK / Jmol), for the colour-by-element 3MF.

const SYMBOLS = ('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr ' +
  'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu ' +
  'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U').split(' ');

// [name, colour to load, preview colour]
const COMMON = {
  1: ['Hydrogen', 'white', 0xf4f2ec],
  5: ['Boron', 'pink', 0xf5a8a0],
  6: ['Carbon', 'black', 0x2a2c31],
  7: ['Nitrogen', 'blue', 0x3459d6],
  8: ['Oxygen', 'red', 0xd9342b],
  9: ['Fluorine', 'light green', 0x8fd66a],
  14: ['Silicon', 'beige', 0xe3c49c],
  15: ['Phosphorus', 'orange', 0xf08a24],
  16: ['Sulfur', 'yellow', 0xf0cf2e],
  17: ['Chlorine', 'green', 0x2fa84f],
  34: ['Selenium', 'orange', 0xf0a030],
  35: ['Bromine', 'dark red', 0x9c2a2a],
  53: ['Iodine', 'purple', 0x8a2a9c],
};

export function elementInfo(z) {
  const symbol = SYMBOLS[z - 1] ?? `Element ${z}`;
  const [name, colourName, colour] = COMMON[z] ?? [symbol, 'any colour', 0xc77dbb];
  return { z, symbol, name, colourName, colour };
}

// One AMS has four slots. Past four elements the rarest ones share the last slot.
export const FILAMENT_SLOTS = 4;

/**
 * @param groups [{ z, count }] → same objects plus element info and filament (1-based): carbon first,
 *               then by atom count. shade is the colour it prints in: its slot's first element's colour.
 */
export function assignFilaments(groups) {
  const sorted = [...groups].sort((a, b) => (b.z === 6) - (a.z === 6) || b.count - a.count || a.z - b.z);
  const out = sorted.map((g, i) => ({ ...g, ...elementInfo(g.z), filament: Math.min(i + 1, FILAMENT_SLOTS) }));
  for (const g of out) g.shade = out.find((o) => o.filament === g.filament).colour;
  return out;
}
