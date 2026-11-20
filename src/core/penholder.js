// Molecule graph -> pen holder solids (Manifold WASM).
//
// The skeletal formula is drawn in the XY plane and every bond becomes a vertical wall.
// Rings turn into closed cells with a floor, which is what holds the pens.
//
//   body   : walls / label columns / floors, from z = 0 to z = height - accentHeight
//   accent : the top "ink" layer - bond lines, double-bond lines, wedges and atom labels,
//            from z = height - accentHeight to z = height (print it in a second colour,
//            or swap filament at that height)
//
// Every accent feature sits directly on top of body material, so the model prints
// without supports.

import { labelFor, labelGlyphs } from './labels.js';

export const DEFAULTS = {
  bondLength: 22, // mm, centre to centre of bonded atoms
  height: 80, // mm, total height
  wall: 2.4, // mm, wall and line thickness
  accentHeight: 2, // mm, top colour layer
  labelScale: 0.55, // label font size as a fraction of bond length
  base: 'floors', // 'floors' | 'plate' | 'none'
  baseThickness: 2, // mm
  plateMargin: 4, // mm, only for base = 'plate'
  labelStyle: 'posts', // 'posts' (solid post under each label) | 'letters' (only the letters, tied together by a foot)
  showTerminalCarbons: true, // label chain ends as CH3 / H3C
  showStereo: true, // wedge / hash bonds
  rotation: 0, // degrees
  mirror: false,
};

const CIRCLE_SEGMENTS = 24;
const MIN_PEN_CELL = 6; // mm, smaller enclosed gaps are not reported as pen cells

/**
 * @param wasm      initialised manifold-3d module (after setup())
 * @param font      three.js Font
 * @param molecule  output of smilesToMolecule()
 * @returns {{ body: Manifold, accent: Manifold, info: object }} caller owns body/accent and must .delete() them
 */
export function buildPenholder(wasm, font, molecule, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const { CrossSection, Manifold } = wasm;
  const pool = [];
  const k = (o) => (pool.push(o), o);
  let body = null;
  let accent = null;

  try {
    const L = p.bondLength;
    const t = p.wall;
    const capH = Math.min(Math.max(p.accentHeight, 0.4), p.height / 3);
    const H = p.height;
    const S = p.labelScale * L; // font size
    const d = Math.max(2 * t, 0.2 * L); // double-bond line spacing
    const wedgeW = Math.max(2.6 * t, 0.3 * L);
    const gap = Math.max(1.0, 0.1 * S); // gap between bond lines and labels on the top face

    const { atoms, bonds, rings } = molecule;
    const pts = layout(atoms, bonds, p);
    const nbrs = atoms.map(() => []);
    for (const b of bonds) { nbrs[b.a].push(b.b); nbrs[b.b].push(b.a); }

    // ---------- labels ----------
    const labelCS = new Map(); // atom index -> CrossSection of glyphs
    const clearances = [];
    const labelBody = [];
    const labelFeet = [];
    atoms.forEach((atom, i) => {
      const dirs = nbrs[i].map((j) => unit(sub(pts[j], pts[i])));
      const spec = labelFor(atom, dirs, p);
      if (!spec) return;
      const groups = labelGlyphs(font, spec, S, pts[i].x, pts[i].y)
        .filter((g) => g.length)
        .map((g) => k(new CrossSection(g, 'EvenOdd')));
      if (!groups.length) return;
      const glyphs = k(k(CrossSection.union(groups)).offset(0.15, 'Round', 2, 12));
      const hull = k(glyphs.hull());
      labelCS.set(i, glyphs);
      clearances.push(k(hull.offset(gap, 'Round', 2, CIRCLE_SEGMENTS)));
      const pad = k(hull.offset(0.8, 'Round', 2, CIRCLE_SEGMENTS));
      if (p.labelStyle === 'letters') {
        labelBody.push(glyphs);
        labelFeet.push(pad); // keeps H, subscripts and charges attached
      } else {
        labelBody.push(pad);
      }
    });

    // ---------- bonds ----------
    const bodyPolys = [];
    const capPolys = [];

    for (const b of bonds) {
      const pa = pts[b.a], pb = pts[b.b];
      const len = dist(pa, pb);
      if (len < 1e-6) continue;
      const u = unit(sub(pb, pa));
      const n = { x: -u.y, y: u.x };

      if (b.order === 1 && p.showStereo && b.stereo) {
        const from = b.from === b.b ? pb : pa;
        const to = b.from === b.b ? pa : pb;
        const wedge = wedgePoly(from, to, t, wedgeW);
        bodyPolys.push(wedge);
        if (b.stereo === 'wedge') capPolys.push(wedge);
        else capPolys.push(...hashBars(from, to, t, wedgeW));
        continue;
      }

      if (b.order === 1) {
        const c = capsule(pa, pb, t);
        bodyPolys.push(c);
        capPolys.push(c);
        continue;
      }

      const lines = [];
      if (b.order === 3) {
        for (const o of [-d, 0, d]) lines.push([add(pa, mul(n, o)), add(pb, mul(n, o))]);
      } else {
        const side = doubleBondSide(b, pts, nbrs, rings, bonds, n);
        if (side === 0) {
          for (const o of [-d / 2, d / 2]) lines.push([add(pa, mul(n, o)), add(pb, mul(n, o))]);
        } else {
          const trim = Math.min(0.577 * d + 0.6 * t, len * 0.35);
          lines.push([pa, pb]);
          lines.push([
            add(add(pa, mul(n, side * d)), mul(u, trim)),
            add(add(pb, mul(n, side * d)), mul(u, -trim)),
          ]);
        }
      }
      const caps = lines.map(([q1, q2]) => capsule(q1, q2, t));
      capPolys.push(...caps);
      // Solid wall under both lines (prints without overhangs) plus the atom-to-atom wall
      bodyPolys.push(convexHull([...caps.flat(), ...capsule(pa, pb, t)]));
    }

    // Lone atoms with no label (shouldn't happen, but keep them visible)
    atoms.forEach((_, i) => {
      if (!nbrs[i].length && !labelCS.has(i)) bodyPolys.push(circlePts(pts[i], 2 * t));
    });

    // ---------- 2D sections ----------
    const walls2D = k(CrossSection.union([...bodyPolys, ...labelBody]));
    if (walls2D.isEmpty()) throw new Error('Nothing to build for this molecule.');

    let cap2D = k(CrossSection.union(capPolys));
    if (clearances.length) cap2D = k(cap2D.subtract(k(CrossSection.union(clearances))));
    const accent2D = k(CrossSection.union([cap2D, ...labelCS.values()]));

    // Floors: fill every enclosed cell (= the outer outlines of the wall section)
    const contours = walls2D.toPolygons();
    const areas = contours.map(signedArea);
    const outerSign = Math.sign(areas.reduce((m, a) => (Math.abs(a) > Math.abs(m) ? a : m), 0)) || 1;
    const outers = contours.filter((_, i) => Math.sign(areas[i]) === outerSign);
    const holes = contours.filter((_, i) => Math.sign(areas[i]) !== outerSign);

    // ---------- 3D ----------
    const wallH = H - capH;
    const parts = [k(walls2D.extrude(wallH))];
    const baseT = Math.min(p.baseThickness, wallH / 2);
    if (p.base === 'floors' || p.base === 'plate') {
      const filled = k(new CrossSection(outers.map((c) => (outerSign > 0 ? c : [...c].reverse())), 'Positive'));
      parts.push(k(filled.extrude(baseT)));
      if (p.base === 'plate') {
        const plate = k(k(walls2D.hull()).offset(p.plateMargin, 'Round', 2, 48));
        parts.push(k(plate.extrude(baseT)));
      }
    }
    if (labelFeet.length) parts.push(k(k(CrossSection.union(labelFeet)).extrude(baseT)));
    body = Manifold.union(parts);
    accent = Manifold.union([k(k(accent2D.extrude(capH)).translate([0, 0, wallH]))]);

    // ---------- info ----------
    const cells = holes
      .map((c) => inscribedDiameter(CrossSection, outerSign > 0 ? [...c].reverse() : c))
      .filter((dia) => dia >= MIN_PEN_CELL)
      .sort((a, b) => a - b);

    const bb = body.boundingBox();
    const ab = accent.isEmpty() ? bb : accent.boundingBox();
    const min = bb.min.map((v, i) => Math.min(v, ab.min[i]));
    const max = bb.max.map((v, i) => Math.max(v, ab.max[i]));
    const info = {
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      bounds: { min, max },
      volume: body.volume() + accent.volume(), // mm^3
      cells,
      bondLength: L,
      accentZ: wallH,
      atoms: atoms.length,
      bonds: bonds.length,
    };
    return { body, accent, info };
  } catch (err) {
    body?.delete();
    accent?.delete();
    throw err;
  } finally {
    for (const o of pool) o.delete();
  }
}

// Scale RDKit coordinates to millimetres, rotate/mirror, centre on the origin.
export function layout(atoms, bonds, p) {
  const lens = bonds
    .map((b) => Math.hypot(atoms[b.a].x - atoms[b.b].x, atoms[b.a].y - atoms[b.b].y))
    .filter((l) => l > 1e-6)
    .sort((a, b) => a - b);
  const med = lens.length ? lens[Math.floor(lens.length / 2)] : 1;
  const s = p.bondLength / med;
  const th = (p.rotation * Math.PI) / 180;
  const c = Math.cos(th), sn = Math.sin(th);
  const pts = atoms.map((a) => {
    const x = a.x * s * (p.mirror ? -1 : 1);
    const y = a.y * s;
    return { x: x * c - y * sn, y: x * sn + y * c };
  });
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  return pts.map((q) => ({ x: q.x - cx, y: q.y - cy }));
}

// Which side of the bond the second line of a double bond goes on: +1 / -1 (along n), 0 = centred.
function doubleBondSide(b, pts, nbrs, rings, bonds, n) {
  const mid = mul(add(pts[b.a], pts[b.b]), 0.5);
  const inRings = rings.filter((r) => r.includes(b.a) && r.includes(b.b));
  if (inRings.length) {
    const doubles = new Set(bonds.filter((x) => x.order === 2).map((x) => `${Math.min(x.a, x.b)}-${Math.max(x.a, x.b)}`));
    const score = (r) => {
      let c = 0;
      for (let i = 0; i < r.length; i++) {
        const a = r[i], z = r[(i + 1) % r.length];
        if (doubles.has(`${Math.min(a, z)}-${Math.max(a, z)}`)) c++;
      }
      return c * 100 - r.length;
    };
    const ring = inRings.reduce((best, r) => (score(r) > score(best) ? r : best));
    const centroid = ring.reduce((acc, i) => add(acc, pts[i]), { x: 0, y: 0 });
    const cen = mul(centroid, 1 / ring.length);
    return dot(n, sub(cen, mid)) >= 0 ? 1 : -1;
  }
  if (nbrs[b.a].length === 1 || nbrs[b.b].length === 1) return 0;
  let sum = 0;
  for (const [x, other] of [[b.a, b.b], [b.b, b.a]]) {
    for (const j of nbrs[x]) if (j !== other) sum += Math.sign(dot(n, sub(pts[j], mid)));
  }
  return Math.sign(sum);
}

// Largest circle that fits in a (positively oriented) hole contour, by binary search on inward offset.
function inscribedDiameter(CrossSection, contour) {
  const cs = new CrossSection([contour], 'Positive');
  try {
    const area = cs.area();
    if (area < 10) return 0;
    let lo = 0, hi = Math.sqrt(area / Math.PI) + 0.5;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      const o = cs.offset(-mid, 'Round', 2, 16);
      const ok = !o.isEmpty();
      o.delete();
      if (ok) lo = mid; else hi = mid;
    }
    return 2 * lo;
  } finally {
    cs.delete();
  }
}

// ---------- 2D helpers (plain JS polygons, CCW) ----------
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a) => { const l = Math.hypot(a.x, a.y) || 1; return { x: a.x / l, y: a.y / l }; };

function circlePts(c, r, n = CIRCLE_SEGMENTS) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([c.x + r * Math.cos(a), c.y + r * Math.sin(a)]);
  }
  return out;
}

function capsule(a, b, w) {
  return convexHull([...circlePts(a, w / 2), ...circlePts(b, w / 2)]);
}

function wedgePoly(from, to, wNarrow, wWide) {
  const u = unit(sub(to, from));
  const n = { x: -u.y, y: u.x };
  const off = Math.max(wWide / 2 - wNarrow / 2, 0);
  return convexHull([
    ...circlePts(from, wNarrow / 2),
    ...circlePts(add(to, mul(n, off)), wNarrow / 2),
    ...circlePts(add(to, mul(n, -off)), wNarrow / 2),
  ]);
}

function hashBars(from, to, wNarrow, wWide) {
  const len = dist(from, to);
  const u = unit(sub(to, from));
  const n = { x: -u.y, y: u.x };
  const bt = Math.max(1.0, 0.5 * wNarrow); // bar thickness along the bond
  const pitch = 2.4 * bt;
  const count = Math.max(3, Math.floor((len - wNarrow / 2) / pitch));
  const bars = [];
  for (let i = 0; i < count; i++) {
    const f = (i + 1) / count; // 0 at the stereocentre, 1 at the far atom
    const along = Math.min(f * len, len - bt / 2);
    const w = wNarrow + (wWide - wNarrow) * (along / len);
    const c = add(from, mul(u, along));
    const hw = mul(n, w / 2), ht = mul(u, bt / 2);
    const quad = [add(add(c, hw), ht), add(sub(c, hw), ht), sub(sub(c, hw), ht), sub(add(c, hw), ht)];
    bars.push(convexHull(quad.map((q) => [q.x, q.y])));
  }
  return bars;
}

// Andrew's monotone chain; input [x,y][], output CCW hull.
function convexHull(points) {
  const P = points.map((q) => (Array.isArray(q) ? q : [q.x, q.y])).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (P.length < 3) return P;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of P) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = P.length - 1; i >= 0; i--) {
    const q = P[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
