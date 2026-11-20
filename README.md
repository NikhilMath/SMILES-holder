# SMILES-holder

Turn any molecule into a 3D-printable pen holder. Type a SMILES string (or search a name), see a live 3D preview, and download an STL, or a two-colour 3MF for Bambu Studio.

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
| Name suggestions while typing | Built-in list of 130 molecules + PubChem autocomplete (3+ letters) |

Code layout:

- `src/core/molecule.js`: RDKit molecule → atoms, bonds, rings, coordinates
- `src/core/labels.js`: which atoms get labels, H placement, glyph layout with subscripts and charges
- `src/core/penholder.js`: the geometry (walls, double-bond lines, wedges, label posts, cell floors, top layer)
- `src/core/stl.js`: binary STL writer
- `src/core/threemf.js`: 3MF writer (one object, body on filament 1 and top layer on filament 2, for Bambu Studio and OrcaSlicer)
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

## Licenses

- RDKit: BSD-3-Clause
- Manifold: Apache-2.0
- three.js: MIT
- Droid Sans font: Apache-2.0 (see `src/assets/fonts/DROID_SANS_LICENSE.txt`)
