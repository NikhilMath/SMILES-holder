// three.js preview of the pen holder or stick model (Z up, millimetres).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x8a7a6a, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 6;
    this.key = key;
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xffe2c4, 0.7);
    rim.position.set(300, 400, 200);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.22 }),
    );
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.materials = {
      body: new THREE.MeshStandardMaterial({ color: 0x23252b, roughness: 0.62, metalness: 0.02 }),
      accent: new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 0.48, metalness: 0.0 }),
      colored: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.02 }),
    };
    this.meshes = { body: null, accent: null };
    this.radius = 100;
    this.center = new THREE.Vector3();

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setColors(body, accent) {
    this.materials.body.color.set(body);
    this.materials.accent.color.set(accent);
  }

  /**
   * @param body   manifold Mesh ({vertProperties, triVerts, numProp}), or [{ mesh, color }] for several colours
   * @param accent manifold Mesh
   */
  setModel(body, accentMesh, { refit = false } = {}) {
    for (const [name, mesh] of [['body', body], ['accent', accentMesh]]) {
      const old = this.meshes[name];
      if (old) { this.scene.remove(old); old.geometry.dispose(); }
      const colored = Array.isArray(mesh);
      const obj = new THREE.Mesh(colored ? coloredGeometry(mesh) : toGeometry(mesh), colored ? this.materials.colored : this.materials[name]);
      obj.castShadow = true;
      obj.receiveShadow = true;
      this.scene.add(obj);
      this.meshes[name] = obj;
    }

    const box = new THREE.Box3().setFromObject(this.meshes.body);
    if (this.meshes.accent.geometry.attributes.position.count) box.union(new THREE.Box3().setFromObject(this.meshes.accent));
    const size = box.getSize(new THREE.Vector3());
    box.getCenter(this.center);
    this.size = size;
    this.radius = size.length() * 0.5 || 50; // bounding-sphere radius

    const span = Math.max(size.x, size.y) * 3 + 400;
    this.ground.scale.set(span, span, 1);
    this.ground.position.set(this.center.x, this.center.y, 0);
    const R = this.radius * 4;
    this.key.position.set(this.center.x - R * 0.5, this.center.y - R * 0.8, R * 1.4);
    this.key.target.position.copy(this.center);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -this.radius * 2.2;
    sc.right = sc.top = this.radius * 2.2;
    sc.near = 1; sc.far = R * 4;
    sc.updateProjectionMatrix();

    if (refit) this.resetView();
  }

  // Distance at which a sphere of radius r fits both the vertical and horizontal field of view.
  fitDistance(r) {
    const vfov = (this.camera.fov * Math.PI) / 180;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    return (r / Math.sin(Math.min(vfov, hfov) / 2)) * 0.92;
  }

  resetView() {
    const dist = this.fitDistance(this.radius);
    const dir = new THREE.Vector3(0.35, -0.95, 0.78).normalize();
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(dir, dist);
    this.camera.near = dist / 50;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
  }

  topView() {
    const dist = this.fitDistance(Math.hypot(this.size.x, this.size.y) * 0.5) + this.size.z;
    this.controls.target.copy(this.center);
    this.camera.position.set(this.center.x, this.center.y - 0.001, this.center.z + dist);
    this.camera.updateProjectionMatrix();
  }
}

function coloredGeometry(parts) {
  const geos = parts.map(({ mesh }) => toGeometry(mesh));
  const count = geos.reduce((n, g) => n + g.attributes.position.count, 0);
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  geos.forEach((g, i) => {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    const c = new THREE.Color(parts[i].color); // converted to linear, like material colours
    for (let v = o; v < o + n; v++) { col[3 * v] = c.r; col[3 * v + 1] = c.g; col[3 * v + 2] = c.b; }
    o += n;
    g.dispose();
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function toGeometry(mesh) {
  const { vertProperties: vp, triVerts: tv, numProp } = mesh;
  const pos = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    const v = tv[i] * numProp;
    pos[3 * i] = vp[v];
    pos[3 * i + 1] = vp[v + 1];
    pos[3 * i + 2] = vp[v + 2];
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals(); // non-indexed -> flat shading
  return g;
}
