// 3D molecule -> printable stick model (Manifold WASM).
//
// Every bond is a round stick and every atom a ball of the same radius, so the joints are
// smooth (a "licorice" model). A stick printed on its own needs supports, so the model is
// cut flat and laid on that face:
//
//   one piece  : shaved flat just under its lowest atoms
//   two halves : cut straight through, both halves printed cut face down, then glued face
//                to face (the faces are mirror images, so they line up by hand)
//
// The cut is chosen by trying a few thousand planes. For each one, the atoms are walked from
// the bed upwards: an atom prints without support when it sits on the bed or a stick rises
// to it steeply enough from an atom that is already supported. The plane with the fewest
// unsupported atoms wins, with small nudges for fewer loose parts, more atoms flat on the
// bed and a lower model.

export const STICK_DEFAULTS = {
  stickBond: 15, // mm, length of a C–C single bond (1.54 Å)
  stick: 5, // mm, stick diameter
  hydrogens: false, // H atoms hanging under their carbon need supports, so they are opt-in
  pieces: 'auto', // 'auto' | 'one' | 'two'
};

const CC_BOND = 1.54; // Å
const SIN_MIN = Math.sin((30 * Math.PI) / 180); // sticks rising at least 30° print without support
const ON_BED = 0.7; // atoms within this × radius of the cut have a footprint on the bed
const KEEP = 0.35; // a half keeps atoms whose centre is at most this × radius beyond the cut
const SHAVE = 0.5; // one piece: the cut sits this × radius below the lowest atom centres
const GLUE = 0.75; // cost of gluing two halves, in "atoms needing support"
const LOOSE_PART = 1.5; // cost of each extra loose part to glue on
const GAP = 8; // mm between the halves on the plate
const BUDGET = 3e7; // rough cap on work for the plane search

// Tall, thin prints wobble and take long: a little cost per mm, more above 25 mm.
const tallness = (h) => 0.004 * h + 0.015 * Math.max(0, h - 25);

/**
 * @param wasm   initialised manifold-3d module
 * @param mol3d  { atoms: [{z, x, y, zc}] in Å, bonds: [{a, b, order}] } from conformer.js
 * @returns {{ plate, marks, assembled, info, layout }} free the manifolds with freeSticks()
 */
export function buildSticks(wasm, mol3d, params = {}) {
  const p = { ...STICK_DEFAULTS, ...params };
  const { Manifold } = wasm;
  const r = p.stick / 2;
  const scale = p.stickBond / CC_BOND; // mm per Å

  // ---------- atoms in mm, without H if asked ----------
  const keep = mol3d.atoms.map((a) => p.hydrogens || a.z !== 1);
  const index = new Map();
  const pts = [];
  const isH = [];
  const elements = [];
  mol3d.atoms.forEach((a, i) => {
    if (!keep[i]) return;
    index.set(i, pts.length);
    pts.push([a.x * scale, a.y * scale, a.zc * scale]);
    isH.push(a.z === 1);
    elements.push(a.z);
  });
  if (!pts.length) throw new Error('Nothing to build for this molecule.');
  const bonds = mol3d.bonds
    .filter((b) => keep[b.a] && keep[b.b])
    .map((b) => ({ a: index.get(b.a), b: index.get(b.b) }));
  const cen = pts.reduce((s, q) => [s[0] + q[0], s[1] + q[1], s[2] + q[2]], [0, 0, 0]).map((v) => v / pts.length);
  for (const q of pts) for (let k = 0; k < 3; k++) q[k] -= cen[k];

  // ---------- pick the cut ----------
  const plan = choosePlan(pts, bonds, isH, r, p.pieces);
  const frame = printFrame(plan.n, pts);
  const Q = pts.map((q) => frame(q));

  // ---------- solids ----------
  const pool = [];
  const k = (o) => (pool.push(o), o);
  let plate = null, marks = null, assembled = null, placed = [];
  try {
    const segs = pts.length > 160 ? 16 : pts.length > 80 ? 20 : r > 4 ? 32 : 24;
    const ball = k(Manifold.sphere(r, segs));
    const ballPts = ballPoints(ball.getMesh());
    const atAtom = (i) => ballPts.map(([x, y, z]) => [x + Q[i][0], y + Q[i][1], z + Q[i][2]]);
    const solids = bonds.map((b) => k(Manifold.hull([...atAtom(b.a), ...atAtom(b.b)])));
    const bonded = new Set(bonds.flatMap((b) => [b.a, b.b]));
    Q.forEach((q, i) => { if (!bonded.has(i)) solids.push(k(ball.translate(q))); });
    const whole = k(Manifold.union(solids));

    // Keep the pieces of each half that hold an atom of that half. The rest are thin caps cut off
    // balls whose centre is on the other side: too small to print and glue, so they are left out.
    const c = plan.c;
    const anchors = (sign) => Q.filter((q) => sign * (q[2] - c) > -KEEP * r)
      .map((q) => [q[0], q[1], sign > 0 ? Math.max(q[2], c + 0.01) : Math.min(q[2], c - 0.01)]);
    const top = k(keepAnchored(Manifold, k(whole.trimByPlane([0, 0, 1], c)), anchors(1), k).translate([0, 0, -c]));
    // flip + t: how each part sits relative to the assembled frame (flip = turned over about X)
    const parts = [{ solid: top, place: (q) => [q[0], q[1], q[2] - c], atoms: plan.unsupported.top, flip: false, t: [0, 0, -c] }];
    if (plan.mode === 'two') {
      const bottom = k(keepAnchored(Manifold, k(whole.trimByPlane([0, 0, -1], -c)), anchors(-1), k).rotate([180, 0, 0]).translate([0, 0, c]));
      parts.push({ solid: bottom, place: (q) => [q[0], -q[1], c - q[2]], atoms: plan.unsupported.bottom, flip: true, t: [0, 0, c] });
    }

    // Lay the parts side by side (y), centred on the origin
    const boxes = parts.map((pt) => pt.solid.boundingBox());
    let y = 0;
    const shifts = boxes.map((bb) => {
      const s = y - bb.min[1];
      y += bb.max[1] - bb.min[1] + GAP;
      return s;
    });
    const xs = boxes.map((bb) => [bb.min[0], bb.max[0]]).flat();
    const dx = -(Math.min(...xs) + Math.max(...xs)) / 2;
    const dy = -(y - GAP) / 2;
    placed = parts.map((pt, i) => pt.solid.translate([dx, shifts[i] + dy, 0]));
    plate = Manifold.compose(placed);

    // Orange balls where the slicer will want support
    const markBalls = [];
    parts.forEach((pt, i) => {
      for (const a of pt.atoms) {
        const [x, yy, z] = pt.place(Q[a]);
        markBalls.push(k(Manifold.sphere(r * 1.25, segs).translate([x + dx, yy + shifts[i] + dy, z])));
      }
    });
    marks = markBalls.length ? k(Manifold.union(markBalls)).trimByPlane([0, 0, 1], 0) : Manifold.compose([]);

    const wb = whole.boundingBox();
    const toAssembled = [-(wb.min[0] + wb.max[0]) / 2, -(wb.min[1] + wb.max[1]) / 2, -wb.min[2]];
    assembled = whole.translate(toAssembled);

    const bb = plate.boundingBox();
    const partCount = placed.reduce((sum, s) => sum + s.decompose().map(k).length, 0);
    const maxBond = Math.max(0, ...bonds.map((b) => Math.hypot(...sub3(pts[b.a], pts[b.b]))));
    const layout = {
      parts: placed.map((solid, i) => ({ solid, flip: parts[i].flip, t: add3(parts[i].t, [dx, shifts[i] + dy, 0]) })),
      assembledAt: { flip: false, t: toAssembled },
      atoms: Q,
      elements,
      r,
      maxBond,
    };
    const info = {
      mode: plan.mode,
      size: [0, 1, 2].map((i) => bb.max[i] - bb.min[i]),
      moleculeSize: [0, 1, 2].map((i) => wb.max[i] - wb.min[i]),
      volume: plate.volume(), // mm^3
      supports: plan.unsupported.top.length + plan.unsupported.bottom.length,
      parts: partCount,
      atoms: pts.length,
      hydrogens: isH.filter(Boolean).length,
      scale,
    };
    return { plate, marks, assembled, info, layout };
  } catch (err) {
    for (const o of [plate, marks, assembled, ...placed]) o?.delete();
    throw err;
  } finally {
    for (const o of pool) o.delete();
  }
}

export function freeSticks(built) {
  for (const m of [built.plate, built.marks, built.assembled, ...built.layout.parts.map((p) => p.solid)]) m.delete();
}

// ---------- colour by element ----------

/**
 * Splits the printed parts by element, the way model kits colour sticks: every point goes to its
 * nearest atom, so each bond changes colour at its middle and the two halves still match when
 * glued. Each atom's share is its Voronoi cell, cut from a box it cannot reach past.
 * @param which 'plate' (the parts laid out to print) or 'assembled'
 * @returns [{ z, count, solid }] one solid per element (caller deletes them)
 */
export function splitByElement(wasm, built, which = 'plate') {
  const { Manifold } = wasm;
  const { atoms: Q, elements, r, maxBond } = built.layout;
  const parts = which === 'assembled' ? [{ solid: built.assembled, ...built.layout.assembledAt }] : built.layout.parts;
  const pool = [];
  const k = (o) => (pool.push(o), o);

  const groups = new Map();
  elements.forEach((z, i) => {
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(i);
  });
  const list = [...groups].map(([z, atoms]) => ({ z, atoms, count: atoms.length }));
  const out = [];
  try {
    if (list.length === 1) return [{ z: list[0].z, count: list[0].count, solid: Manifold.compose(parts.map((p) => p.solid)) }];

    // Every point of the model lies within half a bond plus the stick radius of some atom, so a box of
    // that half-width around each atom holds its whole share. Only atoms whose bisecting plane can
    // reach the box trim it.
    const L = maxBond / 2 + r + 0.5;
    const reach = 2 * L * Math.sqrt(3);
    const box = k(Manifold.cube([2 * L, 2 * L, 2 * L], true));
    const cell = (i) => {
      const q = Q[i];
      let m = box.translate(q);
      Q.forEach((o, j) => {
        if (j === i) return;
        const d = sub3(q, o);
        const len = Math.hypot(...d);
        if (len > reach || len < 1e-6) return;
        const n = scale3(d, 1 / len);
        const next = m.trimByPlane(n, dot3(n, scale3(add3(q, o), 0.5)));
        m.delete();
        m = next;
      });
      return m;
    };
    // The most common element takes what the others leave, so the parts fit with no gaps.
    list.sort((a, b) => b.count - a.count);
    const regions = list.slice(1).map((g) => k(Manifold.union(g.atoms.map((i) => k(cell(i))))));
    const pieces = list.map(() => []);
    for (const p of parts) {
      const place = (m) => (p.flip ? k(k(m.rotate([180, 0, 0])).translate(p.t)) : k(m.translate(p.t)));
      const placedRegions = regions.map(place);
      placedRegions.forEach((reg, g) => pieces[g + 1].push(k(p.solid.intersect(reg))));
      pieces[0].push(k(p.solid.subtract(k(Manifold.union(placedRegions)))));
    }
    list.forEach((g, i) => {
      const solid = Manifold.compose(pieces[i].filter((m) => !m.isEmpty()));
      if (solid.isEmpty()) solid.delete();
      else out.push({ z: g.z, count: g.count, solid });
    });
    return out;
  } catch (err) {
    for (const o of out) o.solid.delete();
    throw err;
  } finally {
    for (const o of pool) o.delete();
  }
}

// ---------- cut search ----------

function choosePlan(pts, bonds, isH, r, pieces) {
  const n = pts.length;
  const nbrs = pts.map(() => []);
  for (const b of bonds) {
    const len = Math.hypot(...sub3(pts[b.a], pts[b.b])) || 1;
    nbrs[b.a].push([b.b, len]);
    nbrs[b.b].push([b.a, len]);
  }
  const heavy = pts.map((_, i) => i).filter((i) => !isH[i]);
  const cutAtoms = heavy.length ? heavy : pts.map((_, i) => i);
  const tryTwo = pieces !== 'one' && n > 1;
  const tryOne = !tryTwo || pieces !== 'two';
  const perDir = (n + bonds.length) * (1 + (tryTwo ? 2 * cutAtoms.length : 0));
  const nDirs = Math.max(150, Math.min(1500, Math.floor(BUDGET / perDir)));

  const h = new Float64Array(n);
  const hb = new Float64Array(n);
  const order = new Int32Array(n);
  const one = { nbrs, isH, r, bonds, n, grazing: false };
  const two = { ...one, grazing: true };

  let best = null;
  const consider = (dir) => {
    const proj = pts.map((q) => dot3(q, dir));
    const ids = Array.from(order.keys()).sort((a, b) => proj[a] - proj[b]);
    for (let i = 0; i < n; i++) order[i] = ids[i];
    if (tryOne) {
      const c = proj[ids[0]] - SHAVE * r;
      for (let i = 0; i < n; i++) h[i] = proj[i] - c;
      const top = evalHalf(h, order, false, one);
      const score = top.cost + tallness(top.height);
      if (!best || score < best.score) best = { score, n: dir, c, mode: 'one', top, bottom: null };
    }
    if (tryTwo) {
      let last = -Infinity;
      for (const ci of [...cutAtoms].sort((a, b) => proj[a] - proj[b])) {
        const c = proj[ci];
        if (c - last < 0.08 * r) continue; // same plane as the previous cut
        last = c;
        for (let i = 0; i < n; i++) { h[i] = proj[i] - c; hb[i] = c - proj[i]; }
        const top = evalHalf(h, order, false, two);
        const bottom = evalHalf(hb, order, true, two);
        const score = top.cost + bottom.cost + GLUE + tallness(Math.max(top.height, bottom.height));
        if (!best || score < best.score) best = { score, n: dir, c, mode: 'two', top, bottom };
      }
    }
  };

  for (const dir of candidateDirections(pts, nbrs, nDirs)) consider(dir);

  // Polish the best direction with small tilts
  for (const step of [5, 2.5, 1.2, 0.6]) {
    const [u, v] = perpendiculars(best.n);
    const t = (step * Math.PI) / 180;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      const off = add3(scale3(u, Math.cos(ang) * Math.sin(t)), scale3(v, Math.sin(ang) * Math.sin(t)));
      consider(norm3(add3(scale3(best.n, Math.cos(t)), off)));
    }
  }

  return {
    n: best.n,
    c: best.c,
    mode: best.mode,
    unsupported: { top: best.top.unsupported, bottom: best.bottom?.unsupported ?? [] },
  };
}

// Walks one half from the bed up. h[i] = height of atom i above the cut (negative = other half).
// grazing: penalise atoms the cut only just misses (two halves), as they leave thin slivers.
function evalHalf(h, order, reverse, { nbrs, isH, r, bonds, n, grazing }) {
  const bed = ON_BED * r;
  const supported = new Uint8Array(n);
  const unsupported = [];
  let cost = 0, height = 0, onBed = 0;
  for (let s = 0; s < n; s++) {
    const i = order[reverse ? n - 1 - s : s];
    const hi = h[i];
    if (hi <= -bed) continue; // in the other half
    if (hi + r > height) height = hi + r;
    if (hi <= bed) {
      supported[i] = 1;
      onBed++;
      if (grazing && Math.abs(hi) > 0.3 * r) cost += 0.1;
      continue;
    }
    if (grazing && hi < r) cost += 0.1;
    let ok = false;
    for (const [j, len] of nbrs[i]) {
      const hj = h[j];
      if (hj < hi && (hj <= bed || supported[j]) && (hi - hj) / len >= SIN_MIN) { ok = true; break; }
    }
    supported[i] = 1;
    if (!ok) {
      unsupported.push(i);
      cost += isH[i] ? 0.5 : 1;
    }
  }
  // Loose parts: groups of atoms in this half not joined by a bond inside it
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  for (const b of bonds) if (h[b.a] > -bed && h[b.b] > -bed) parent[find(b.a)] = find(b.b);
  const roots = new Set();
  for (let i = 0; i < n; i++) if (h[i] > -KEEP * r) roots.add(find(i));
  cost += LOOSE_PART * Math.max(0, roots.size - 1) - 0.04 * onBed;
  return { cost, height, unsupported };
}

// Even spread over the sphere, plus planes the molecule itself suggests (its best-fit plane and
// the plane through each atom and two of its neighbours, which lays rings and chains flat).
function candidateDirections(pts, nbrs, count) {
  const dirs = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const rad = Math.sqrt(1 - z * z);
    dirs.push([rad * Math.cos(i * golden), rad * Math.sin(i * golden), z]);
  }
  const special = [bestFitNormal(pts)];
  pts.forEach((q, i) => {
    const ns = nbrs[i];
    for (let a = 0; a < ns.length && special.length < 400; a++) {
      for (let b = a + 1; b < ns.length; b++) {
        const nrm = cross3(sub3(pts[ns[a][0]], q), sub3(pts[ns[b][0]], q));
        if (Math.hypot(...nrm) > 1e-6) special.push(norm3(nrm));
      }
    }
  });
  for (const d of special) dirs.push(d, scale3(d, -1));
  return dirs;
}

function bestFitNormal(pts) {
  // Smallest-variance axis of the covariance matrix, by power iteration on (trace·I − C)
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const q of pts) for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) C[a][b] += q[a] * q[b];
  const tr = C[0][0] + C[1][1] + C[2][2];
  let v = [0.31, 0.53, 0.79];
  for (let it = 0; it < 60; it++) {
    const w = [0, 1, 2].map((a) => tr * v[a] - (C[a][0] * v[0] + C[a][1] * v[1] + C[a][2] * v[2]));
    const l = Math.hypot(...w);
    if (l < 1e-12) break;
    v = w.map((x) => x / l);
  }
  return v;
}

// Rotation taking the cut normal to +Z, then turning the model so its long side runs along X.
function printFrame(nrm, pts) {
  const [e1, e2] = perpendiculars(nrm);
  const flat = pts.map((q) => [dot3(q, e1), dot3(q, e2)]);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of flat) { sxx += x * x; syy += y * y; sxy += x * y; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const c = Math.cos(th), s = Math.sin(th);
  return (q) => {
    const x = dot3(q, e1), y = dot3(q, e2);
    return [x * c + y * s, -x * s + y * c, dot3(q, nrm)];
  };
}

function perpendiculars(nrm) {
  const a = Math.abs(nrm[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm3(cross3(a, nrm));
  return [e1, cross3(nrm, e1)];
}

function keepAnchored(Manifold, solid, anchors, k) {
  const pieces = solid.decompose().map(k);
  const inside = (bb, q) => q.every((v, i) => v >= bb.min[i] - 1e-3 && v <= bb.max[i] + 1e-3);
  const kept = pieces.filter((m) => {
    const bb = m.boundingBox();
    return anchors.some((q) => inside(bb, q));
  });
  return kept.length === pieces.length ? solid : k(Manifold.compose(kept));
}

function ballPoints(mesh) {
  const { vertProperties: vp, numProp } = mesh;
  const out = [];
  for (let i = 0; i < vp.length; i += numProp) out.push([vp[i], vp[i + 1], vp[i + 2]]);
  return out;
}

const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
