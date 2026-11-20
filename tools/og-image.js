// Renders the link-preview card: a caffeine pen holder (same geometry code as the app) with a few
// pens in its ring cells. `npm run og` waits for window.__ogReady and takes the screenshot.
import Module from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import * as THREE from 'three';
import { Font } from 'three/addons/loaders/FontLoader.js';
import fontData from '../src/assets/fonts/droid_sans_bold.typeface.json';
import { smilesToMolecule } from '../src/core/molecule.js';
import { buildPenholder, DEFAULTS, layout } from '../src/core/penholder.js';
import { Viewer } from '../src/viewer.js';

const SMILES = 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C'; // caffeine
const PARAMS = { ...DEFAULTS };

// Camera: direction from the model, and how far right of centre the model sits (fraction of width).
const VIEW_DIR = new THREE.Vector3(0.38, -0.92, 1.15);
const SHIFT_X = 0.245;
const ZOOM = 1.0;

// Pens per ring cell (rings sorted largest first). offset: mm from the ring centre at the floor.
// lean: [degrees from vertical, azimuth in degrees]. spin: rotation about the pen's own axis.
const PENS = [
  { ring: 0, kind: 'pen', color: 0xe0703a, offset: [-4, -5], lean: [10, 140], spin: 30 },
  { ring: 0, kind: 'pencil', color: 0xf2b632, offset: [4, -5], lean: [10, 50], spin: 0 },
  { ring: 1, kind: 'pen', color: 0x2f5d9e, offset: [1, -4], lean: [9, 122], spin: 330 },
];

try {
  const [RDKit, wasm] = await Promise.all([
    window.initRDKitModule({ locateFile: () => '/vendor/rdkit/RDKit_minimal.wasm' }),
    Module({ locateFile: () => manifoldWasmUrl }),
  ]);
  wasm.setup();
  const molecule = smilesToMolecule(RDKit, SMILES);
  const { body, accent } = buildPenholder(wasm, new Font(fontData), molecule, PARAMS);

  const viewer = new Viewer(document.getElementById('viewer'));
  viewer.renderer.setPixelRatio(2); // supersample: the canvas is drawn at 2x and scaled down
  viewer.resize();
  viewer.controls.enabled = false;
  viewer.controls.enableDamping = false;
  viewer.setModel(body.getMesh(), accent.getMesh());

  const pens = makePens(molecule);
  viewer.scene.add(pens);
  frame(viewer, [viewer.meshes.body, viewer.meshes.accent, pens]);

  await nextFrames(4);
  window.__ogReady = true;
} catch (err) {
  window.__ogError = String(err?.stack || err);
  throw err;
}

function frame(viewer, objects) {
  const box = new THREE.Box3();
  for (const o of objects) box.expandByObject(o);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;

  // Key light and its shadow camera must cover the pens too.
  const R = radius * 4;
  viewer.key.position.set(center.x - R * 0.5, center.y - R * 0.8, R * 1.4);
  viewer.key.target.position.copy(center);
  const sc = viewer.key.shadow.camera;
  sc.left = sc.bottom = -radius * 2.2;
  sc.right = sc.top = radius * 2.2;
  sc.near = 1;
  sc.far = R * 4;
  sc.updateProjectionMatrix();

  const cam = viewer.camera;
  const { clientWidth: w, clientHeight: h } = viewer.container;
  cam.setViewOffset(w, h, -w * SHIFT_X, 0, w, h);
  const dist = viewer.fitDistance(radius) / ZOOM;
  viewer.controls.target.copy(center);
  cam.position.copy(center).addScaledVector(VIEW_DIR.clone().normalize(), dist);
  cam.lookAt(center);
  cam.near = dist / 50;
  cam.far = dist * 20;
  cam.updateProjectionMatrix();
}

function makePens(molecule) {
  const pts = layout(molecule.atoms, molecule.bonds, PARAMS);
  const rings = [...molecule.rings].sort((a, b) => b.length - a.length);
  const centres = rings.map((r) => {
    const c = r.reduce((s, i) => ({ x: s.x + pts[i].x, y: s.y + pts[i].y }), { x: 0, y: 0 });
    return { x: c.x / r.length, y: c.y / r.length };
  });

  const group = new THREE.Group();
  for (const spec of PENS) {
    const c = centres[spec.ring];
    if (!c) continue;
    const item = spec.kind === 'pencil' ? pencil(spec.color) : pen(spec.color);
    item.rotation.y = (spec.spin * Math.PI) / 180;
    const holder = new THREE.Group();
    holder.add(item);
    const [tilt, az] = spec.lean.map((d) => (d * Math.PI) / 180);
    const dir = new THREE.Vector3(Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt));
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    holder.position.set(c.x + spec.offset[0], c.y + spec.offset[1], PARAMS.baseThickness);
    group.add(holder);
  }
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return group;
}

// Both are built along +Y from y = 0 (the end resting on the floor).
function pen(color) {
  const g = new THREE.Group();
  const barrelMat = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.05 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xd7d4cf, roughness: 0.28, metalness: 0.55 });
  const r = 4.4;
  add(g, new THREE.CylinderGeometry(r, r, 116, 40), barrelMat, 58);
  add(g, new THREE.CylinderGeometry(r * 0.96, r, 2, 40), metal, 117);
  add(g, new THREE.CylinderGeometry(r * 0.92, r * 0.96, 14, 40), barrelMat, 125);
  add(g, new THREE.CylinderGeometry(2.1, 2.3, 7, 24), metal, 135.5);
  const clip = add(g, new THREE.BoxGeometry(2.2, 36, 1.4), metal, 112);
  clip.position.z = r + 0.9;
  const clipTop = add(g, new THREE.BoxGeometry(2.2, 3, r + 1.6), metal, 129);
  clipTop.position.z = (r + 1.6) / 2;
  return g;
}

function pencil(color) {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color, roughness: 0.55, flatShading: true });
  const metal = new THREE.MeshStandardMaterial({ color: 0xc9c4bb, roughness: 0.3, metalness: 0.55 });
  const eraser = new THREE.MeshStandardMaterial({ color: 0xe88f8f, roughness: 0.85 });
  const r = 4.1;
  add(g, new THREE.CylinderGeometry(r, r, 122, 6), wood, 61);
  for (const [y, h] of [[124, 4], [128.5, 3], [131.5, 3]]) {
    add(g, new THREE.CylinderGeometry(r * 0.98, r * 0.98, h, 32), metal, y);
  }
  add(g, new THREE.CylinderGeometry(r * 0.92, r * 0.95, 7, 32), eraser, 136.5);
  return g;
}

function add(group, geometry, material, y) {
  const m = new THREE.Mesh(geometry, material);
  m.position.y = y;
  group.add(m);
  return m;
}

function nextFrames(n) {
  return new Promise((resolve) => {
    const step = () => (--n <= 0 ? resolve() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });
}
