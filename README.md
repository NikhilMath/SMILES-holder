# SMILES-holder

Turn any molecule into a 3D-printable pen holder. Type a SMILES string (or search a name), see a live 3D preview, and download an STL.

**Live site:** https://smiles-penholder.netlify.app

The skeletal formula is drawn flat and every bond becomes a vertical wall. Rings become closed cells with a floor, and those cells hold the pens. Atom labels (N, OH, H₃C, …), double bonds and stereo wedges are drawn on the top face as a separate top layer, so you can print that layer in a second colour.

## How it works

Everything runs in the browser. There is no server.

| Step | Library |
| --- | --- |
| SMILES → 2D layout, bond orders, wedges, rings, implicit H | [RDKit.js](https://github.com/rdkit/rdkit-js) (CoordGen depiction) |
| Atom labels → outlines | three.js `Font` + Droid Sans Bold |
| 2D outlines → watertight solids (unions, offsets, extrusion) | [Manifold](https://github.com/elalish/manifold) (WASM) |
| Preview | three.js |
| Name → SMILES | PubChem PUG REST |

Code layout:

- `src/core/molecule.js`: RDKit molecule → atoms, bonds, rings, coordinates
- `src/core/labels.js`: which atoms get labels, H placement, glyph layout with subscripts and charges
- `src/core/penholder.js`: the geometry (walls, double-bond lines, wedges, label posts, cell floors, top layer)
- `src/core/stl.js`: binary STL writer
- `src/main.js`, `src/viewer.js`: UI and 3D preview

## Develop

```bash
npm install
```

```bash
npm run dev
```

Command-line generator (same geometry code, useful for testing):

```bash
npm run stl -- "CN1C=NC2=C1C(=O)N(C(=O)N2C)C" caffeine.stl --bondLength=22 --height=80
```

This writes `caffeine.stl` plus `caffeine-body.stl` and `caffeine-accent.stl`.

## Deploy

Netlify builds from `main` using `netlify.toml` (`npm run build` → `dist/`).

## Printing tips

- **One colour:** use *Download STL*.
- **Two colours, multi-material printer:** load *Body STL* and *Top layer STL* together as one multi-part object, then assign a filament to each.
- **Two colours, one nozzle:** print the full STL and add a filament change at the Z height shown under the download buttons (height minus the top layer).
- Ring cells need to be about 12 mm across or more to hold a pen. Raise the bond length if the app warns you.
- Molecules without rings have no closed cells. Use the *Full plate* base so it stands up.

## Licenses

- RDKit: BSD-3-Clause
- Manifold: Apache-2.0
- three.js: MIT
- Droid Sans font: Apache-2.0 (see `src/assets/fonts/DROID_SANS_LICENSE.txt`)
