// Atom labels ("N", "OH", "H₃C", "NH⁺" ...) as 2D outlines built from a typeface font.

const SUB = 0.62; // subscript / superscript scale
const CURVE_SEGMENTS = 5;

/**
 * Decide what text (if any) an atom gets, and on which side its hydrogens go.
 * @param atom   {sym, hs, charge}
 * @param dirs   unit vectors from this atom toward each bonded neighbour
 */
export function labelFor(atom, dirs, { showTerminalCarbons }) {
  const isCarbon = atom.sym === 'C';
  const show =
    !isCarbon ||
    atom.charge !== 0 ||
    dirs.length === 0 ||
    (showTerminalCarbons && dirs.length === 1);
  if (!show) return null;

  let side = 'right';
  if (atom.hs > 0 && dirs.length > 0) {
    const sx = dirs.reduce((s, d) => s + d.x, 0);
    const sy = dirs.reduce((s, d) => s + d.y, 0);
    if (dirs.length === 1) {
      side = sx > 0.1 ? 'left' : 'right';
    } else if (sx > 0.35) side = 'left';
    else if (sx < -0.35) side = 'right';
    else if (Math.abs(sy) > 0.35) side = sy > 0 ? 'down' : 'up';
    else side = 'right';
  }
  return { symbol: atom.sym, hs: atom.hs, charge: atom.charge, side };
}

function chargeText(c) {
  if (!c) return '';
  const sign = c > 0 ? '+' : '−';
  const n = Math.abs(c);
  return (n > 1 ? String(n) : '') + sign;
}

/**
 * Turn a label spec into polygons, positioned so the element symbol is centred on (cx, cy).
 * @returns {number[][][]} list of contours (outer + hole rings), EvenOdd fill per glyph group
 */
export function labelGlyphs(font, spec, size, cx, cy) {
  const res = font.data.resolution;
  const glyphs = []; // {contours, run}

  // Lay out one row of runs, returning glyph contours and the run each came from.
  const layRow = (runs) => {
    let x = 0;
    const out = [];
    for (const run of runs) {
      const s = size * run.scale;
      for (const ch of run.text) {
        const g = font.data.glyphs[ch] ?? font.data.glyphs['?'];
        const contours = charContours(font, ch, s).map((c) => c.map(([px, py]) => [px + x, py + run.dy * size]));
        if (contours.length) out.push({ contours, tag: run.tag });
        x += (g.ha * s) / res;
      }
    }
    return out;
  };

  const hText = spec.hs > 0 ? 'H' : '';
  const hNum = spec.hs > 1 ? String(spec.hs) : '';
  const chg = chargeText(spec.charge);
  const symRun = { text: spec.symbol, scale: 1, dy: 0, tag: 'sym' };
  const chgRun = { text: chg, scale: SUB, dy: 0.55, tag: 'chg' };
  const hRuns = [
    { text: hText, scale: 1, dy: 0, tag: 'h' },
    { text: hNum, scale: SUB, dy: -0.22, tag: 'h' },
  ];

  if (spec.side === 'left') glyphs.push(...layRow([...hRuns, symRun, chgRun]));
  else if (spec.side === 'right') glyphs.push(...layRow([symRun, ...hRuns, chgRun]));
  else {
    const main = layRow([symRun, chgRun]);
    const hrow = layRow(hRuns);
    const sb = bounds(main.filter((g) => g.tag === 'sym'));
    const hb = bounds(hrow);
    if (hrow.length) {
      const gap = 0.16 * size;
      const dx = (sb.minX + sb.maxX) / 2 - (hb.minX + hb.maxX) / 2;
      const dy = spec.side === 'up' ? sb.maxY + gap - hb.minY : sb.minY - gap - hb.maxY;
      for (const g of hrow) g.contours = g.contours.map((c) => c.map(([x, y]) => [x + dx, y + dy]));
    }
    glyphs.push(...main, ...hrow);
  }

  // Centre the element symbol on the atom.
  const sb = bounds(glyphs.filter((g) => g.tag === 'sym'));
  const ox = cx - (sb.minX + sb.maxX) / 2;
  const oy = cy - (sb.minY + sb.maxY) / 2;
  return glyphs.map((g) => g.contours.map((c) => c.map(([x, y]) => [x + ox, y + oy])));
}

const glyphCache = new Map();

function charContours(font, ch, size) {
  const k = `${ch}@${size.toFixed(4)}`;
  if (glyphCache.has(k)) return glyphCache.get(k);
  const contours = [];
  for (const shape of font.generateShapes(ch, size)) {
    const { shape: outer, holes } = shape.extractPoints(CURVE_SEGMENTS);
    for (const ring of [outer, ...holes]) {
      const pts = ring.map((p) => [p.x, p.y]);
      if (pts.length > 1) {
        const [a, b] = [pts[0], pts[pts.length - 1]];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) pts.pop();
      }
      if (pts.length >= 3) contours.push(pts);
    }
  }
  if (glyphCache.size > 2000) glyphCache.clear();
  glyphCache.set(k, contours);
  return contours;
}

function bounds(glyphs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of glyphs) for (const c of g.contours) for (const [x, y] of c) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
