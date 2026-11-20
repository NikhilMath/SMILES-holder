// Type-ahead suggestions for the molecule name box.
// Built-in molecules match from the first letter. PubChem's autocomplete fills in the rest
// once there are 3+ letters (it returns nothing for shorter queries).
import { EXAMPLES, POPULAR } from './molecules.js';

const MAX_ITEMS = 10;
const REMOTE_MIN = 3;
const REMOTE_DELAY = 180; // ms after the last keystroke

// One entry per name people might type. Aliases point at the main name.
const INDEX = [
  ...EXAMPLES.map(([name, smiles, aliases = []], i) => ({ name, smiles, aliases, rank: i, library: true })),
  ...POPULAR.map(([name, smiles, aliases = []], i) => ({ name, smiles, aliases, rank: 100 + i, library: false })),
].flatMap((m) => [
  { label: m.name, smiles: m.smiles, rank: m.rank, library: m.library },
  ...m.aliases.map((alias) => ({ label: alias, sub: m.name, smiles: m.smiles, rank: m.rank + 0.5, library: m.library })),
]);

const words = (s) => s.toLowerCase().split(/[\s\-,()]+/).filter(Boolean);

function localMatches(query) {
  const q = query.toLowerCase();
  const hits = [];
  for (const item of INDEX) {
    const label = item.label.toLowerCase();
    // 0 = name starts with it, 1 = a later word starts with it ("acid" → "Folic acid").
    const score = label.startsWith(q) ? 0 : words(label).some((w) => w.startsWith(q)) ? 1 : -1;
    if (score >= 0) hits.push({ ...item, score });
  }
  hits.sort((a, b) => a.score - b.score || a.rank - b.rank);
  // One row per molecule: if both "Cannabidiol" and its alias "CBD" match, keep the better one.
  const seen = new Set();
  return hits.filter((h) => !seen.has(h.smiles) && seen.add(h.smiles));
}

// PubChem returns some names in all caps or all lower case; tidy them for display.
function tidy(name) {
  if (name === name.toLowerCase()) return name.charAt(0).toUpperCase() + name.slice(1);
  if (name === name.toUpperCase()) {
    const lower = name.replace(/[A-Z]{3,}/g, (w) => w.toLowerCase());
    return lower.replace(/[a-z]/, (c) => c.toUpperCase());
  }
  return name;
}

const remoteCache = new Map();
async function remoteMatches(query, signal) {
  const key = query.toLowerCase();
  if (remoteCache.has(key)) return remoteCache.get(key);
  const url = `https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/${encodeURIComponent(query)}/json?limit=${MAX_ITEMS}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`PubChem autocomplete ${res.status}`);
  const json = await res.json();
  const names = (json?.dictionary_terms?.compound ?? []).map(tidy);
  remoteCache.set(key, names);
  return names;
}

/**
 * Wire suggestions to a text input.
 * onPick({ label, smiles }) gets `smiles` for built-in molecules, or no `smiles` for a
 * PubChem name that still needs looking up.
 */
export function setupSuggest(input, list, onPick) {
  let items = [];
  let active = -1;
  let pending = false;
  let timer = 0;
  let ctl = null;

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-expanded', 'false');
  list.setAttribute('role', 'listbox');

  function update() {
    const query = input.value.trim();
    clearTimeout(timer);
    ctl?.abort();
    pending = false;
    if (!query) return close();

    const local = localMatches(query);
    items = local.slice(0, MAX_ITEMS);
    active = -1;
    if (query.length >= REMOTE_MIN && local.length < MAX_ITEMS) {
      const cached = remoteCache.get(query.toLowerCase());
      if (cached) items = merge(local, cached);
      else {
        pending = true;
        timer = setTimeout(() => fetchRemote(query, local), REMOTE_DELAY);
      }
    }
    render(query);
  }

  async function fetchRemote(query, local) {
    ctl = new AbortController();
    try {
      const names = await remoteMatches(query, ctl.signal);
      if (input.value.trim() !== query) return;
      const activeLabel = items[active]?.label;
      items = merge(local, names);
      active = items.findIndex((it) => it.label === activeLabel);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Offline or PubChem is down: keep the built-in suggestions.
    }
    pending = false;
    render(query);
  }

  function merge(local, names) {
    const seen = new Set(local.flatMap((it) => [it.label.toLowerCase(), it.sub?.toLowerCase()]));
    const remote = names
      .filter((n) => !seen.has(n.toLowerCase()))
      .map((label) => ({ label, remote: true }));
    return [...local, ...remote].slice(0, MAX_ITEMS);
  }

  function render(query) {
    list.replaceChildren();
    if (!items.length && !pending) return close();
    const q = query.toLowerCase();
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.append(highlight(item.label, q));
      if (item.sub) li.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: item.sub }));
      if (item.library) li.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'Library' }));
      li.addEventListener('pointerdown', (e) => e.preventDefault()); // keep focus in the input
      li.addEventListener('click', () => pick(i));
      li.addEventListener('pointermove', () => { if (active !== i) setActive(i); });
      list.append(li);
    });
    if (pending) {
      const li = document.createElement('li');
      li.className = 'status';
      li.setAttribute('aria-hidden', 'true');
      li.textContent = 'Searching PubChem…';
      list.append(li);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    syncActive();
  }

  // Bold the part of the name that matches what was typed.
  function highlight(label, q) {
    const span = document.createElement('span');
    span.className = 'name';
    const lower = label.toLowerCase();
    let at = lower.startsWith(q) ? 0 : -1;
    if (at < 0) {
      const m = new RegExp(`(^|[\\s\\-,()])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(lower);
      if (m) at = m.index + m[1].length;
    }
    if (at < 0) span.textContent = label;
    else {
      const strong = document.createElement('strong');
      strong.textContent = label.slice(at, at + q.length);
      span.append(label.slice(0, at), strong, label.slice(at + q.length));
    }
    return span;
  }

  function setActive(i) {
    active = i;
    syncActive();
  }

  function syncActive() {
    [...list.querySelectorAll('[role="option"]')].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    const el = active >= 0 ? list.children[active] : null;
    if (el) {
      input.setAttribute('aria-activedescendant', el.id);
      el.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }

  function close() {
    clearTimeout(timer);
    ctl?.abort();
    pending = false;
    items = [];
    active = -1;
    list.hidden = true;
    list.replaceChildren();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function pick(i) {
    const item = items[i];
    if (!item) return;
    input.value = item.label;
    close();
    onPick({ label: item.label, smiles: item.smiles });
  }

  input.addEventListener('input', update);
  input.addEventListener('focus', () => { if (input.value.trim()) update(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    const open = !list.hidden && items.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) return update();
      setActive((active + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      if (!open) return;
      e.preventDefault();
      setActive(active <= 0 ? items.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      if (open && active >= 0) {
        e.preventDefault(); // pick the highlighted one instead of submitting the typed text
        pick(active);
      } else close();
    } else if (e.key === 'Escape') {
      if (!list.hidden) {
        e.preventDefault(); // close the list without clearing the box
        close();
      }
    }
  });

  return { close };
}
