import './style.css';
import Module from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from './assets/fonts/droid_sans_bold.typeface.json';
import { smilesToMolecule, smilesToSvg } from './core/molecule.js';
import { buildPenholder, DEFAULTS } from './core/penholder.js';
import { manifoldToSTL } from './core/stl.js';
import { Viewer } from './viewer.js';
import { EXAMPLES } from './molecules.js';
import { setupSuggest } from './suggest.js';

const SIZE_CONTROLS = [
  { key: 'bondLength', label: 'Bond length', min: 12, max: 40, step: 0.5, unit: 'mm' },
  { key: 'height', label: 'Height', min: 30, max: 150, step: 1, unit: 'mm' },
  { key: 'wall', label: 'Wall thickness', min: 1.2, max: 5, step: 0.1, unit: 'mm' },
  { key: 'rotation', label: 'Rotate', min: -180, max: 180, step: 5, unit: '°' },
];
const STYLE_CONTROLS = [
  { key: 'base', label: 'Base', type: 'segmented', options: [['floors', 'Cell floors'], ['plate', 'Full plate'], ['none', 'None']] },
  { key: 'labelStyle', label: 'Labels', type: 'segmented', options: [['posts', 'On posts'], ['letters', 'Letters only']] },
  { key: 'labelScale', label: 'Label size', min: 0.3, max: 0.9, step: 0.01, unit: '%', scale: 100 },
  { key: 'accentHeight', label: 'Top layer', min: 0.6, max: 4, step: 0.1, unit: 'mm' },
  { key: 'showTerminalCarbons', label: 'Label chain ends (CH₃)', type: 'toggle' },
  { key: 'showStereo', label: 'Stereo wedges', type: 'toggle' },
  { key: 'mirror', label: 'Mirror', type: 'toggle' },
];
const PLA_DENSITY = 1.24; // g/cm³

const $ = (id) => document.getElementById(id);
const state = { smiles: EXAMPLES[0][1], name: EXAMPLES[0][0], params: { ...DEFAULTS } };
let engine = null; // { RDKit, wasm, font }
let model = null; // { body, accent, info }
let molCache = { smiles: null, molecule: null };
let lastSmilesForView = null;
let timer = 0;
const controlEls = new Map();

const viewer = new Viewer($('viewer'));

readUrl();
buildControls();
bindEvents();
init();

async function init() {
  try {
    const [RDKit, wasm] = await Promise.all([
      window.initRDKitModule({ locateFile: () => `${import.meta.env.BASE_URL}vendor/rdkit/RDKit_minimal.wasm` }),
      Module({ locateFile: () => manifoldWasmUrl }),
    ]);
    wasm.setup();
    engine = { RDKit, wasm, font: new Font(fontData) };
    $('loading').hidden = true;
    regenerate();
  } catch (err) {
    console.error(err);
    $('loading').innerHTML = '<span>Could not load the 3D engine. Try reloading the page.</span>';
  }
}

// ---------- generation ----------
function schedule(delay = 80) {
  clearTimeout(timer);
  timer = setTimeout(regenerate, delay);
}

function regenerate() {
  if (!engine) return;
  const { RDKit, wasm, font } = engine;
  writeUrl();
  let molecule;
  try {
    if (molCache.smiles !== state.smiles) {
      molCache = { smiles: state.smiles, molecule: smilesToMolecule(RDKit, state.smiles) };
      $('drawing').innerHTML = smilesToSvg(RDKit, state.smiles, 320, 200);
    }
    molecule = molCache.molecule;
  } catch (err) {
    molCache = { smiles: null, molecule: null };
    $('drawing').innerHTML = '';
    showMsg(err.message, 'error');
    return;
  }

  try {
    const next = buildPenholder(wasm, font, molecule, state.params);
    const refit = lastSmilesForView !== state.smiles;
    viewer.setModel(next.body.getMesh(), next.accent.getMesh(), { refit });
    lastSmilesForView = state.smiles;
    if (model) { model.body.delete(); model.accent.delete(); }
    model = next;
    showMsg(state.name ? state.name : '', 'ok');
    updateStats();
  } catch (err) {
    console.error(err);
    showMsg(`Could not build this one: ${err.message}`, 'error');
  }
}

function updateStats() {
  const { info } = model;
  const [w, d, h] = info.size;
  $('stat-size').textContent = `${w.toFixed(0)} × ${d.toFixed(0)} mm`;
  $('stat-height').textContent = `${h.toFixed(0)} mm`;
  const cells = info.cells;
  $('stat-cells').textContent = cells.length
    ? `${cells.length} · smallest Ø${cells[0].toFixed(0)} mm`
    : 'none';
  $('stat-weight').textContent = `≤ ${Math.round((info.volume / 1000) * PLA_DENSITY)} g`;

  const bed = Number($('bed').value);
  const fit = $('fit-msg');
  const notes = [];
  if (Math.max(w, d) > bed) notes.push(`Too big for a ${bed} mm bed — try “Fit to bed”.`);
  if (!cells.length) notes.push('No rings, so no closed cells: pens will lean on the fins. A full plate base helps it stand.');
  else if (cells[0] < 12) notes.push('Some cells are narrower than a pen (~12 mm). Increase the bond length.');
  fit.textContent = notes.join(' ');
  fit.classList.toggle('warn', notes.length > 0);

  $('color-tip').textContent =
    `Two colours: load Body + Top layer as one multi-part object, or with one nozzle swap filament at Z = ${info.accentZ.toFixed(1)} mm.`;
}

// ---------- downloads ----------
function download(kind) {
  if (!model) return;
  const { wasm } = engine;
  let solid = kind === 'body' ? model.body : kind === 'accent' ? model.accent : wasm.Manifold.union(model.body, model.accent);
  try {
    const bytes = manifoldToSTL(solid, `${state.name || 'molecule'} pen holder`);
    const suffix = kind === 'all' ? '' : kind === 'body' ? '-body' : '-top';
    const blob = new Blob([bytes], { type: 'model/stl' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug(state.name || 'molecule')}-pen-holder${suffix}.stl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } finally {
    if (kind === 'all') solid.delete();
  }
}

function fitToBed() {
  if (!model) return;
  const bed = Number($('bed').value) - 6; // a little margin
  const [w, d] = model.info.size;
  const scale = bed / Math.max(w, d);
  const ctl = SIZE_CONTROLS[0];
  const next = Math.min(ctl.max, Math.max(ctl.min, Math.floor(state.params.bondLength * scale * 2) / 2));
  setParam('bondLength', next);
}

// ---------- name lookup ----------
async function lookupName(name) {
  const q = name.trim();
  if (!q) return;
  showMsg(`Looking up “${q}”…`, 'busy');
  try {
    const url = `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(q)}/property/SMILES,Title/JSON`;
    const res = await fetch(url);
    if (res.status === 404) throw new Error(`PubChem has no molecule called “${q}”.`);
    if (!res.ok) throw new Error('PubChem lookup failed. Try again in a moment.');
    const json = await res.json();
    const hit = json?.PropertyTable?.Properties?.[0];
    if (!hit?.SMILES) throw new Error(`No SMILES found for “${q}”.`);
    state.name = hit.Title || q;
    setSmiles(hit.SMILES);
  } catch (err) {
    showMsg(err.message, 'error');
  }
}

// ---------- UI wiring ----------
function setSmiles(smiles, { fromInput = false } = {}) {
  state.smiles = smiles.trim();
  if (!fromInput) $('smiles').value = state.smiles;
  markExample();
  schedule(fromInput ? 350 : 0);
}

function setParam(key, value) {
  state.params[key] = value;
  syncControl(key);
  schedule();
}

function bindEvents() {
  $('smiles').value = state.smiles;
  $('smiles').addEventListener('input', (e) => {
    state.name = '';
    setSmiles(e.target.value, { fromInput: true });
  });
  const suggest = setupSuggest($('name'), $('suggest'), ({ label, smiles }) => {
    if (smiles) { state.name = label; setSmiles(smiles); }
    else lookupName(label);
  });
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    suggest.close();
    lookupName($('name').value);
  });
  const chips = $('examples');
  for (const [name, smi] of EXAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = name;
    b.dataset.smiles = smi;
    b.addEventListener('click', () => { state.name = name; setSmiles(smi); });
    chips.appendChild(b);
  }
  markExample();
  $('dl-all').addEventListener('click', () => download('all'));
  $('dl-body').addEventListener('click', () => download('body'));
  $('dl-accent').addEventListener('click', () => download('accent'));
  $('fit').addEventListener('click', fitToBed);
  $('bed').addEventListener('change', () => model && updateStats());
  $('view-3d').addEventListener('click', () => viewer.resetView());
  $('view-top').addEventListener('click', () => viewer.topView());
  bindAbout();
}

// ---------- about dialog ----------
function bindAbout() {
  const dlg = $('about');
  $('about-open').addEventListener('click', openAbout);
  dlg.addEventListener('click', (e) => {
    // The dialog box itself has no padding, so a click that lands on it directly is on the backdrop.
    if (e.target === dlg || e.target.closest('[data-close]')) return dlg.close();
    const ex = e.target.closest('[data-example]');
    if (ex) {
      const hit = EXAMPLES.find(([name]) => name === ex.dataset.example);
      dlg.close();
      if (hit) { state.name = hit[0]; setSmiles(hit[1]); }
      return;
    }
    if (e.target.closest('[data-library]')) {
      dlg.close();
      const chips = $('examples');
      chips.scrollIntoView({ block: 'center', behavior: 'smooth' });
      chips.querySelector('.chip')?.focus({ preventScroll: true });
    }
  });
  dlg.addEventListener('close', () => history.replaceState(null, '', `${location.pathname}${location.search}`));
  if (location.hash === '#about') openAbout();
}

function openAbout() {
  const dlg = $('about');
  if (!dlg.open) dlg.showModal();
  history.replaceState(null, '', `${location.pathname}${location.search}#about`);
}

function markExample() {
  for (const b of $('examples').children) b.classList.toggle('active', b.dataset.smiles === state.smiles);
}

function buildControls() {
  for (const [containerId, list] of [['size-controls', SIZE_CONTROLS], ['style-controls', STYLE_CONTROLS]]) {
    const box = $(containerId);
    for (const c of list) box.appendChild(makeControl(c));
  }
}

function makeControl(c) {
  const row = document.createElement('div');
  row.className = `control ${c.type ?? 'range'}`;
  if (c.type === 'segmented') {
    row.innerHTML = `<span class="field-label">${c.label}</span><div class="segmented" role="radiogroup" aria-label="${c.label}"></div>`;
    const seg = row.querySelector('.segmented');
    for (const [val, text] of c.options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.dataset.value = val;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => setParam(c.key, val));
      seg.appendChild(b);
    }
  } else if (c.type === 'toggle') {
    row.innerHTML = `<label class="toggle"><input type="checkbox" /><span class="track"></span><span>${c.label}</span></label>`;
    row.querySelector('input').addEventListener('change', (e) => setParam(c.key, e.target.checked));
  } else {
    const id = `ctl-${c.key}`;
    row.innerHTML = `<label class="range-head" for="${id}"><span class="field-label">${c.label}</span><output></output></label>
      <input id="${id}" type="range" min="${c.min}" max="${c.max}" step="${c.step}" />`;
    row.querySelector('input').addEventListener('input', (e) => setParam(c.key, Number(e.target.value)));
  }
  controlEls.set(c.key, { c, row });
  syncControl(c.key);
  return row;
}

function syncControl(key) {
  const entry = controlEls.get(key);
  if (!entry) return;
  const { c, row } = entry;
  const v = state.params[key];
  if (c.type === 'segmented') {
    for (const b of row.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.value === v));
  } else if (c.type === 'toggle') {
    row.querySelector('input').checked = !!v;
  } else {
    const input = row.querySelector('input');
    if (Number(input.value) !== v) input.value = v;
    const shown = c.scale ? Math.round(v * c.scale) : v;
    row.querySelector('output').textContent = `${shown}${c.unit === '%' ? '%' : c.unit === '°' ? '°' : ` ${c.unit}`}`;
  }
}

function showMsg(text, kind) {
  const el = $('msg');
  el.textContent = text;
  el.dataset.kind = kind;
}

// ---------- shareable URLs ----------
function readUrl() {
  const q = new URLSearchParams(location.search);
  if (q.get('s')) { state.smiles = q.get('s'); state.name = q.get('n') ?? ''; }
  for (const [k, def] of Object.entries(DEFAULTS)) {
    if (!q.has(k)) continue;
    const raw = q.get(k);
    state.params[k] = typeof def === 'number' ? Number(raw) : typeof def === 'boolean' ? raw === '1' : raw;
  }
}

function writeUrl() {
  const q = new URLSearchParams();
  q.set('s', state.smiles);
  if (state.name) q.set('n', state.name);
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = state.params[k];
    if (v !== def) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'molecule';
}
