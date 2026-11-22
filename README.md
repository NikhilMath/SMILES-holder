# SMILES-holder

Turn any molecule into a 3D-printable pen holder. Type a SMILES string (or search a name), see a live 3D preview, and download an STL, or a two-colour 3MF for Bambu Studio.

**Live site:** https://smiles-penholder.netlify.app

The skeletal formula is drawn flat and every bond becomes a vertical wall. Rings become closed cells with a floor, and those cells hold the pens. Atom labels (N, OH, H₃C, …), double bonds and stereo wedges are drawn on the top face as a separate top layer, so you can print that layer in a second colour.

**Just print the molecule:** the link at the bottom switches to a 3D stick model of the molecule itself (its real shape, not the flat drawing). To print with few or no supports, the model is cut flat: either shaved under its lowest atoms (one piece) or split through the middle into two halves that print cut face down and are glued face to face. The preview and the *Bambu 3MF* are coloured by element like a model kit (carbon black, oxygen red, nitrogen blue, …), each element on its own filament.

## How it works

Everything runs in the browser. There is no server.

| Step | Library |
| --- | --- |
| SMILES → 2D layout, bond orders, wedges, rings, implicit H | [RDKit.js](https://github.com/rdkit/rdkit-js) (CoordGen depiction) |
| Atom labels → outlines | three.js `Font` + Droid Sans Bold |
| 2D outlines → watertight solids (unions, offsets, extrusion) | [Manifold](https://github.com/elalish/manifold) (WASM) |
| Preview | three.js |
| Name → SMILES | PubChem PUG REST |
| Name suggestions while typing | Built-in list of 130 molecules + PubChem autocomplete (3+ letters) |
| SMILES → 3D shape for the stick model | [OpenChemLib](https://github.com/cheminfo/openchemlib-js) conformer generator + MMFF94s+, in a Web Worker, checked against RDKit's R/S and E/Z labels |

Code layout:

- `src/core/molecule.js`: RDKit molecule → atoms, bonds, rings, coordinates
- `src/core/labels.js`: which atoms get labels, H placement, glyph layout with subscripts and charges
- `src/core/penholder.js`: the geometry (walls, double-bond lines, wedges, label posts, cell floors, top layer)
- `src/core/stl.js`: binary STL writer
- `src/core/threemf.js`: 3MF writer (one object, body on filament 1 and top layer on filament 2, for Bambu Studio and OrcaSlicer)
- `src/core/conformer.js`, `src/core/conformer-worker.js`: 3D conformer for the stick model (flattest of a few dozen likely conformers, stereo checked, retried with other seeds)
- `src/core/sticks.js`: stick-model geometry, the search for the flat cut that needs the fewest supports, and the split into one part per element (each point goes to its nearest atom, so every bond changes colour halfway)
- `src/core/elements.js`: element names, model-kit colours and which filament each element gets
- `src/main.js`, `src/viewer.js`: UI and 3D preview
- `src/molecules.js`: the example library and the popular molecules used for search suggestions
- `src/suggest.js`: type-ahead suggestions for the name search

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

This writes `caffeine.stl` plus `caffeine-body.stl`, `caffeine-accent.stl` and `caffeine.3mf`.

Stick model of the molecule itself:

```bash
npm run molecule -- "CN1C=NC2=C1C(=O)N(C(=O)N2C)C" caffeine-sticks.stl --stickBond=15 --stick=5 --hydrogens=true --pieces=two
```

This writes the print plate, `caffeine-sticks-assembled.stl` (the whole molecule in one piece) and `caffeine-sticks.3mf` (coloured by element).

## Deploy

Netlify builds from `main` using `netlify.toml` (`npm run build` → `dist/`).

## Link preview

The Open Graph tags in `index.html` point at `public/og-image.png` (1200 × 630), the card LinkedIn, iMessage, Slack and others show when someone shares the link. It is rendered from `tools/og-image.html` with the same geometry code as the app (a caffeine pen holder with a few pens in it). To change it, edit that page and re-render with headless Chrome:

```bash
npm run og
```

This also writes `public/apple-touch-icon.png`. LinkedIn caches previews for about a week; paste the URL into the [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) to refresh it.

## Printing tips

- **One colour:** use *Download STL*.
- **Two colours, Bambu Studio or OrcaSlicer:** use *Bambu 3MF*. It opens as one object with two parts, the body on filament 1 and the top layer on filament 2. Pick a colour for each filament (or sync your AMS) and slice. There is one filament change, at the top layer. If you only have one filament set up, Bambu Studio adds the second.
- **Two colours, other multi-material slicers:** load *Body STL* and *Top layer STL* together as one multi-part object, then assign a filament to each.
- **Two colours, one nozzle:** print the full STL and add a filament change at the layer shown under the download buttons. That is the first layer above the body, e.g. 78.2 mm for an 80 mm holder at 0.2 mm layers.
- Ring cells need to be about 12 mm across or more to hold a pen. Raise the bond length if the app warns you.
- Molecules without rings have no closed cells. Use the *Full plate* base so it stands up.

### Stick model (*Just print the molecule*)

- **Best fit** picks one piece or two halves, whichever needs fewer supports. Two halves print cut face down; glue them face to face with superglue. The faces are mirror images, so they line up by hand.
- Atoms that still need support are shown in orange, and the count is under *Supports*. Tree supports in the slicer handle them.
- Hydrogens are off by default: a hydrogen hanging under its carbon always needs support. Turn them on for the full molecule.
- *Whole model STL* is the molecule in one piece, for resin printers or printing with supports.
- **Colours, Bambu Studio or OrcaSlicer:** *Bambu 3MF* opens as one object with one part per element, named after the element and its usual colour. Carbon is on filament 1, then the others by how many atoms they have; the tip under the downloads lists them. Load those colours (or sync your AMS) and slice. An AMS has four slots, so if a molecule has more than four elements (usually only with hydrogens on), the rarest ones share filament 4. Change a part's filament to give it its own. Every bond changes colour halfway, so most layers have filament changes: expect a longer print and more purge than one colour.
- Across the 130 built-in molecules (skeleton only), about two thirds print with no supports at all.

## Licenses

- RDKit: BSD-3-Clause
- OpenChemLib: BSD-3-Clause
- Manifold: Apache-2.0
- three.js: MIT
- Droid Sans font: Apache-2.0 (see `src/assets/fonts/DROID_SANS_LICENSE.txt`)
