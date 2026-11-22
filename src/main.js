import './style.css';
import Module from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from './assets/fonts/droid_sans_bold.typeface.json';
import { smilesToMolecule, smilesToSvg } from './core/molecule.js';
import { buildPenholder, DEFAULTS } from './core/penholder.js';
import { conformerFor } from './core/conformer.js';
import { buildSticks, STICK_DEFAULTS } from './core/sticks.js';
import { manifoldToSTL } from './core/stl.js';
import { manifoldsTo3MF } from './core/threemf.js';
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
// "Just print the molecule": a 3D stick model instead of the pen holder (group 'm' = state.mparams)
const MOLECULE_SIZE_CONTROLS = [
  { key: 'stickBond', label: 'Bond length (C–C)', min: 8, max: 30, step: 0.5, unit: 'mm', group: 'm' },
  { key: 'stick', label: 'Stick thickness', min: 2.5, max: 8, step: 0.1, unit: 'mm', group: 'm' },
];
const MOLECULE_STYLE_CONTROLS = [
  { key: 'pieces', label: 'Print as', type: 'segmented', options: [['auto', 'Best fit'], ['two', 'Two halves'], ['one', 'One piece']], group: 'm' },
  { key: 'hydrogens', label: 'Hydrogens (often need supports)', type: 'toggle', group: 'm' },
];
const PLA_DENSITY = 1.24; // g/cm³
const BODY_COLOR = 0x23252b;
const ACCENT_COLOR = 0xf3f0e8;
const SUPPORT_COLOR = 0xe8743b;
const EMPTY_MESH = { vertProperties: new Float32Array(0), triVerts: new Uint32Array(0), numProp: 3 };

const $ = (id) => document.getElementById(id);
const state = {
  smiles: EXAMPLES[0][1],
  name: EXAMPLES[0][0],
  mode: 'holder', // 'holder' | 'molecule'
  params: { ...DEFAULTS },
  mparams: { ...STICK_DEFAULTS },
  assembled: false, // molecule view: put back together instead of laid out for printing
};
let engine = null; // { RDKit, wasm, font }
let model = null; // { body, accent, info }
let sticks = null; // { plate, marks, assembled, info, note }
let molCache = { smiles: null, molecule: null };
const confCache = new Map(); // SMILES -> 3D conformer
let confJob = null; // the conformer worker currently running
let lastViewKey = null;
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
    stopConformer();
    showMsg(err.message, 'error');
    return;
  }

  if (state.mode === 'molecule') {
    regenerateSticks();
    return;
  }

  try {
    const next = buildPenholder(wasm, font, molecule, state.params);
    viewer.setModel(next.body.getMesh(), next.accent.getMesh(), { refit: takeRefit() });
    if (model) { model.body.delete(); model.accent.delete(); }
    model = next;
    showMsg(state.name ? state.name : '', 'ok');
    updateStats();
  } catch (err) {
    console.error(err);
    showMsg(`Could not build this one: ${err.message}`, 'error');
  }
}

// Refit the camera when the molecule, the mode or the stick-model layout changes, not on size tweaks.
function takeRefit() {
  const key = [state.mode, state.smiles, state.mode === 'molecule' ? `${state.assembled}:${state.mparams.pieces}` : ''].join('|');
  const refit = key !== lastViewKey;
  lastViewKey = key;
  return refit;
}

// ---------- stick model ("just print the molecule") ----------
async function regenerateSticks() {
  const smiles = state.smiles;
  let conf = confCache.get(smiles);
  if (!conf) {
    if (confJob?.smiles === smiles) return; // still working on it; it builds with the latest settings
    const job = startConformer(smiles);
    setBusy('Working out the 3D shape…');
    try {
      conf = await conformerFor(engine.RDKit, smiles, job.generate);
    } catch (err) {
      if (job !== confJob) return; // replaced by a newer molecule
      console.error(err);
      showMsg(err.message, 'error');
      return;
    } finally {
      if (job === confJob) stopConformer();
    }
    confCache.set(smiles, conf);
    if (state.smiles !== smiles || state.mode !== 'molecule') return;
  }
  buildStickModel(conf);
}

function buildStickModel(conf) {
  try {
    const next = buildSticks(engine.wasm, conf, state.mparams);
    if (sticks) for (const m of [sticks.plate, sticks.marks, sticks.assembled]) m.delete();
    sticks = { ...next, note: conf.note };
    showSticks(takeRefit());
    showMsg(state.name ? state.name : '', 'ok');
    updateStats();
  } catch (err) {
    console.error(err);
    showMsg(`Could not build this one: ${err.message}`, 'error');
  }
}

function showSticks(refit) {
  if (!sticks) return;
  if (state.assembled) viewer.setModel(sticks.assembled.getMesh(), EMPTY_MESH, { refit });
  else viewer.setModel(sticks.plate.getMesh(), sticks.marks.getMesh(), { refit });
}

// OpenChemLib runs in a worker. Each molecule gets a fresh one: that cancels a slow job when the
// molecule changes, and clears a cache that can carry stereochemistry over between molecules.
function startConformer(smiles) {
  stopConformer();
  const worker = new Worker(new URL('./core/conformer-worker.js', import.meta.url), { type: 'module' });
  const resources = new URL(`${import.meta.env.BASE_URL}vendor/openchemlib/resources.json`, location.href).href;
  const pending = new Map();
  let seq = 0;
  const failAll = (message) => {
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id);
    if (!p) return;
    pending.delete(data.id);
    if (data.error) p.reject(new Error(data.error));
    else p.resolve(data.result);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    failAll('The 3D engine could not start. Try reloading the page.');
  };
  const job = {
    smiles,
    generate: (molfile, seed) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, molfile, seed, resources });
    }),
    stop: () => { worker.terminate(); failAll('Stopped.'); },
  };
  confJob = job;
  return job;
}

function stopConformer() {
  if (!confJob) return;
  const job = confJob;
  confJob = null;
  job.stop();
  setBusy(null);
}

function setBusy(text) {
  const el = $('loading');
  el.hidden = !text;
  el.classList.toggle('over', !!text);
  if (text) el.querySelector('span').textContent = text;
  for (const id of ['dl-all', 'dl-whole']) $(id).disabled = !!text; // the model on screen is the previous molecule
}

function updateStats() {
  if (state.mode === 'molecule') updateStickStats();
  else if (model) updateHolderStats();
}

function updateStickStats() {
  if (!sticks) return;
  const { info, note } = sticks;
  const [w, d, h] = info.size;
  $('stat-size').textContent = `${w.toFixed(0)} × ${d.toFixed(0)} mm`;
  $('stat-height').textContent = `${h.toFixed(0)} mm`;
  $('stat-cells').textContent = info.supports ? `${info.supports} ${info.supports === 1 ? 'spot' : 'spots'}` : 'none';
  $('stat-weight').textContent = `≤ ${Math.round((info.volume / 1000) * PLA_DENSITY)} g`;

  const bed = Number($('bed').value);
  const notes = [];
  if (Math.max(w, d) > bed) notes.push(`Too big for a ${bed} mm bed — try “Fit to bed”.`);
  if (info.supports) {
    const alt = state.mparams.hydrogens ? ', or turn off hydrogens'
      : info.mode === 'one' && state.mparams.pieces !== 'auto' ? ', or print it as two halves' : '';
    notes.push(`The orange ${info.supports === 1 ? 'atom needs' : 'atoms need'} a little support: turn on supports in your slicer (tree supports work best)${alt}.`);
  }
  if (note) notes.push(note);
  const fit = $('fit-msg');
  fit.textContent = notes.join(' ');
  fit.classList.toggle('warn', notes.length > 0);

  const extra = info.parts - (info.mode === 'two' ? 2 : 1);
  const how = info.mode === 'two'
    ? 'Two halves: print both cut face down, then glue them face to face with a drop of superglue. The faces are mirror images, so they line up by hand.'
    : 'One piece: it prints on the flat spot shaved off its underside.';
  const bits = extra > 0 ? ` ${extra === 1 ? 'One small bit prints' : `${extra} small bits print`} on its own: glue it back where it fits.` : '';
  $('color-tip').textContent = `${how}${bits} Scale: 1 Å = ${info.scale.toFixed(1)} mm.`;
}

function updateHolderStats() {
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
    `Two colours: the Bambu 3MF opens in Bambu Studio or OrcaSlicer with the body on filament 1 and the top layer on filament 2, so you only pick the colours. ` +
    `In other slicers, load Body + Top layer as one multi-part object, or with one nozzle swap filament at the ${swapLayerZ(info.accentZ).toFixed(1)} mm layer (0.2 mm layers).`;
}

// Slicers list layers by their top height and put a layer in the top colour when its middle is
// above the body, so the filament change goes on the first such layer (78.2 mm for an 80 mm holder).
function swapLayerZ(bodyTopZ, layer = 0.2) {
  return (Math.floor(bodyTopZ / layer + 0.5 + 1e-9) + 1) * layer;
}

// ---------- downloads ----------
function download(kind) {
  if (state.mode === 'molecule') {
    if (!sticks) return;
    const whole = kind === 'whole';
    const bytes = manifoldToSTL(whole ? sticks.assembled : sticks.plate, `${state.name || 'molecule'} stick model`);
    saveFile(bytes, 'model/stl', `${slug(state.name || 'molecule')}-molecule${whole ? '-whole' : ''}.stl`);
    return;
  }
  if (!model) return;
  const { wasm } = engine;
  let solid = kind === 'body' ? model.body : kind === 'accent' ? model.accent : wasm.Manifold.union(model.body, model.accent);
  try {
    const bytes = manifoldToSTL(solid, `${state.name || 'molecule'} pen holder`);
    const suffix = kind === 'all' ? '' : kind === 'body' ? '-body' : '-top';
    saveFile(bytes, 'model/stl', `${slug(state.name || 'molecule')}-pen-holder${suffix}.stl`);
  } finally {
    if (kind === 'all') solid.delete();
  }
}

// One object, two parts: body on filament 1, top layer on filament 2 (Bambu Studio / OrcaSlicer).
async function download3MF() {
  if (!model) return;
  const btn = $('dl-3mf');
  btn.disabled = true;
  try {
    const half = Number($('bed').value) / 2; // land in the middle of the plate
    const bytes = await manifoldsTo3MF([
      { name: 'Body', manifold: model.body, filament: 1 },
      { name: 'Top layer', manifold: model.accent, filament: 2 },
    ], { name: `${state.name || 'Molecule'} pen holder`, center: [half, half] });
    saveFile(bytes, 'model/3mf', `${slug(state.name || 'molecule')}-pen-holder.3mf`);
  } catch (err) {
    console.error(err);
    showMsg(`Could not make the 3MF: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

function saveFile(bytes, type, filename) {
  const blob = new Blob([bytes], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function fitToBed() {
  if (state.mode === 'molecule') {
    if (!sticks) return;
    const bed = Number($('bed').value) - 6;
    const [w, d] = sticks.info.size;
    const ctl = MOLECULE_SIZE_CONTROLS[0];
    const scale = (bed / Math.max(w, d)) * 0.97; // the stick thickness and the gap between halves do not scale
    setParam('stickBond', Math.min(ctl.max, Math.max(ctl.min, Math.floor(state.mparams.stickBond * scale * 2) / 2)));
    return;
  }
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
  paramsOf(controlEls.get(key).c)[key] = value;
  syncControl(key);
  schedule();
}

function paramsOf(c) {
  return c.group === 'm' ? state.mparams : state.params;
}

function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  if (mode !== 'molecule') stopConformer();
  applyMode();
  schedule(0);
}

function applyMode() {
  const m = state.mode === 'molecule';
  $('size-controls').hidden = m;
  $('style-controls').hidden = m;
  $('msize-controls').hidden = !m;
  $('mstyle-controls').hidden = !m;
  for (const id of ['dl-body', 'dl-accent', 'dl-3mf']) $(id).hidden = m;
  $('dl-whole').hidden = !m;
  $('view-assembled').hidden = !m;
  $('stat-cells-label').textContent = m ? 'Supports' : 'Pen cells';
  $('mode-link').textContent = m ? '← Back to the pen holder' : 'Just print the molecule →';
  viewer.setColors(BODY_COLOR, m ? SUPPORT_COLOR : ACCENT_COLOR);
  for (const id of ['stat-size', 'stat-height', 'stat-cells', 'stat-weight']) $(id).textContent = '–';
  $('fit-msg').textContent = '';
  $('color-tip').textContent = '';
  updateModeLink();
}

function updateModeLink() {
  const q = new URLSearchParams(location.search);
  if (state.mode === 'molecule') q.delete('view');
  else q.set('view', 'molecule');
  $('mode-link').href = `${location.pathname}?${q}`;
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
  $('dl-3mf').addEventListener('click', download3MF);
  $('dl-whole').addEventListener('click', () => download('whole'));
  $('fit').addEventListener('click', fitToBed);
  $('bed').addEventListener('change', updateStats);
  $('view-3d').addEventListener('click', () => viewer.resetView());
  $('view-top').addEventListener('click', () => viewer.topView());
  $('view-assembled').addEventListener('click', () => {
    state.assembled = !state.assembled;
    $('view-assembled').setAttribute('aria-pressed', String(state.assembled));
    $('view-assembled').classList.toggle('active', state.assembled);
    showSticks(takeRefit());
  });
  $('mode-link').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return; // new tab / window
    e.preventDefault();
    setMode(state.mode === 'molecule' ? 'holder' : 'molecule');
  });
  applyMode();
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
  for (const [containerId, list] of [
    ['size-controls', SIZE_CONTROLS], ['style-controls', STYLE_CONTROLS],
    ['msize-controls', MOLECULE_SIZE_CONTROLS], ['mstyle-controls', MOLECULE_STYLE_CONTROLS],
  ]) {
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
  const v = paramsOf(c)[key];
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
  if (q.get('view') === 'molecule') state.mode = 'molecule';
  for (const [defaults, params] of [[DEFAULTS, state.params], [STICK_DEFAULTS, state.mparams]]) {
    for (const [k, def] of Object.entries(defaults)) {
      if (!q.has(k)) continue;
      const raw = q.get(k);
      params[k] = typeof def === 'number' ? Number(raw) : typeof def === 'boolean' ? raw === '1' : raw;
    }
  }
}

function writeUrl() {
  const q = new URLSearchParams();
  q.set('s', state.smiles);
  if (state.name) q.set('n', state.name);
  const groups = [[DEFAULTS, state.params]];
  if (state.mode === 'molecule') {
    q.set('view', 'molecule');
    groups.push([STICK_DEFAULTS, state.mparams]);
  }
  for (const [defaults, params] of groups) {
    for (const [k, def] of Object.entries(defaults)) {
      const v = params[k];
      if (v !== def) q.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }
  }
  history.replaceState(null, '', `${location.pathname}?${q}${location.hash}`);
  updateModeLink();
}

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'molecule';
}
