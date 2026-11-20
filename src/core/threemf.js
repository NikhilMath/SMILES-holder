// 3MF writer for multi-part models (units: millimetres, Z up).
//
// The parts become one object, so they stay locked together in the slicer. Each part
// carries a filament number in Metadata/model_settings.config, the file Bambu Studio and
// OrcaSlicer read for per-part settings. The pen holder opens with the body on filament 1
// and the top layer on filament 2, ready for an AMS, and a colour change is one click.
// The geometry itself is plain 3MF core, so other slicers can open the file too.
//
// No colour resources are written on purpose: Bambu Studio treats a third-party 3MF with
// colours as a colour-matching import and drops the per-part filament assignments.

const MODEL_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';

/**
 * @param parts   [{ name, manifold, filament }] filament is 1-based
 * @param options name: object name, center: [x, y] where the object lands on the plate
 * @returns Promise<Uint8Array> the .3mf (zip) bytes
 */
export async function manifoldsTo3MF(parts, { name = 'SMILES pen holder', center = [0, 0] } = {}) {
  const used = parts.filter((p) => p.manifold && !p.manifold.isEmpty());
  if (!used.length) throw new Error('Nothing to export.');
  const objectId = used.length + 1;
  const enc = new TextEncoder();

  const model = [];
  model.push(
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${MODEL_NS}">\n`,
    ' <metadata name="Application">Molecule Pen Holder</metadata>\n',
    ` <metadata name="Title">${esc(name)}</metadata>\n`,
    ' <resources>\n',
  );
  used.forEach((p, i) => {
    model.push(`  <object id="${i + 1}" type="model" name="${esc(p.name)}">\n`);
    meshXml(p.manifold.getMesh(), model);
    model.push('  </object>\n');
  });
  model.push(`  <object id="${objectId}" type="model" name="${esc(name)}">\n   <components>\n`);
  used.forEach((_, i) => model.push(`    <component objectid="${i + 1}"/>\n`));
  model.push('   </components>\n  </object>\n </resources>\n');
  model.push(` <build>\n  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${num(center[0])} ${num(center[1])} 0" printable="1"/>\n </build>\n</model>\n`);

  const settings = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n',
    ` <object id="${objectId}">\n`,
    `  <metadata key="name" value="${esc(name)}"/>\n`,
    `  <metadata key="extruder" value="${used[0].filament}"/>\n`,
    ...used.map((p, i) =>
      `  <part id="${i + 1}" subtype="normal_part">\n` +
      `   <metadata key="name" value="${esc(p.name)}"/>\n` +
      `   <metadata key="extruder" value="${p.filament}"/>\n` +
      '  </part>\n'),
    ' </object>\n</config>\n',
  ];

  return zip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: encodeChunks(enc, model) },
    { name: 'Metadata/model_settings.config', data: enc.encode(settings.join('')) },
  ]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="config" ContentType="text/xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function meshXml({ vertProperties: vp, triVerts: tv, numProp }, out) {
  const nVert = vp.length / numProp;
  out.push('   <mesh>\n    <vertices>\n');
  for (let i = 0; i < nVert; i++) {
    const o = i * numProp;
    out.push(`     <vertex x="${num(vp[o])}" y="${num(vp[o + 1])}" z="${num(vp[o + 2])}"/>\n`);
  }
  out.push('    </vertices>\n    <triangles>\n');
  for (let t = 0; t < tv.length; t += 3) {
    out.push(`     <triangle v1="${tv[t]}" v2="${tv[t + 1]}" v3="${tv[t + 2]}"/>\n`);
  }
  out.push('    </triangles>\n   </mesh>\n');
}

// Micron precision is far below what a printer resolves and keeps the file small.
const num = (v) => String(Math.round(v * 1e4) / 1e4);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// Joining a few hundred thousand short strings in one go can exceed engine limits, so encode in slices.
function encodeChunks(enc, strings) {
  const parts = [];
  let size = 0;
  for (let i = 0; i < strings.length; i += 20000) {
    const bytes = enc.encode(strings.slice(i, i + 20000).join(''));
    parts.push(bytes);
    size += bytes.length;
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------- minimal zip writer (deflate when the platform has CompressionStream) ----------

async function zip(files) {
  const { time, date } = dosDateTime(new Date());
  const entries = [];
  for (const f of files) {
    const deflated = await deflateRaw(f.data);
    const useDeflate = deflated && deflated.length < f.data.length;
    entries.push({
      name: new TextEncoder().encode(f.name),
      crc: crc32(f.data),
      size: f.data.length,
      body: useDeflate ? deflated : f.data,
      method: useDeflate ? 8 : 0,
    });
  }

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, e.method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, e.crc, true);
    local.setUint32(18, e.body.length, true);
    local.setUint32(22, e.size, true);
    local.setUint16(26, e.name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), e.name, e.body);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); // version made by
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, e.method, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, e.crc, true);
    cd.setUint32(20, e.body.length, true);
    cd.setUint32(24, e.size, true);
    cd.setUint16(28, e.name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), e.name);
    offset += 30 + e.name.length + e.body.length;
  }

  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);

  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of all) { out.set(c, o); o += c.length; }
  return out;
}

async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null; // older browsers without deflate-raw: store uncompressed
  }
}

let CRC_TABLE = null;
function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
