// Binary STL writer for Manifold meshes (units: millimetres, Z up).

export function manifoldToSTL(manifold, title = 'SMILES pen holder') {
  const { vertProperties: vp, triVerts: tv, numProp } = manifold.getMesh();
  const nTri = tv.length / 3;
  const buf = new ArrayBuffer(84 + nTri * 50);
  const view = new DataView(buf);
  const header = `${title}`.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
  for (let i = 0; i < header.length; i++) view.setUint8(i, header.charCodeAt(i));
  view.setUint32(80, nTri, true);

  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const i0 = tv[3 * t] * numProp, i1 = tv[3 * t + 1] * numProp, i2 = tv[3 * t + 2] * numProp;
    const ax = vp[i0], ay = vp[i0 + 1], az = vp[i0 + 2];
    const bx = vp[i1], by = vp[i1 + 1], bz = vp[i1 + 2];
    const cx = vp[i2], cy = vp[i2 + 1], cz = vp[i2 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz, ax, ay, az, bx, by, bz, cx, cy, cz]) {
      view.setFloat32(o, v, true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}
