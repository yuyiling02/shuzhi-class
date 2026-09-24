import fs from 'node:fs';
import zlib from 'node:zlib';
import draco3d from 'draco3d';

/* ---------- PNG ---------- */
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function writePNG(file, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

/* ---------- GLB + Draco ---------- */
const b = fs.readFileSync(process.argv[2] || 'public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const parts = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dmod.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dmod.Decoder(); const mesh = new dmod.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  const n = mesh.num_points();
  const read = (uid, comps) => {
    if (uid === undefined) return null;
    const a = dec.GetAttributeByUniqueId(mesh, uid);
    const arr = new dmod.DracoFloat32Array();
    dec.GetAttributeFloatForAllPoints(mesh, a, arr);
    const o = new Float32Array(n * comps);
    for (let i = 0; i < o.length; i++) o[i] = arr.GetValue(i);
    return o;
  };
  const col = json.materials[p.material].pbrMetallicRoughness.baseColorFactor;
  parts.push({
    mi, name: json.meshes[mi].name, n,
    pos: read(ext.attributes.POSITION, 3),
    nrm: read(ext.attributes.NORMAL, 3),
    color: col.slice(0, 3),
  });
}
const gmn = [Infinity, Infinity, Infinity], gmx = [-Infinity, -Infinity, -Infinity];
for (const pt of parts) for (let i = 0; i < pt.pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pt.pos[i + k] < gmn[k]) gmn[k] = pt.pos[i + k]; if (pt.pos[i + k] > gmx[k]) gmx[k] = pt.pos[i + k]; }
const center = gmn.map((v, k) => (v + gmx[k]) / 2);

const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];

function renderView(W, H, viewDir, upHint, palette, opts = {}) {
  const d = norm(viewDir);
  const r = norm(cross(upHint, d));
  const u = norm(cross(d, r));
  const lights = [norm([-0.5, 0.7, 0.9]), norm([0.8, 0.4, 0.3])];
  const rgb = Buffer.alloc(W * H * 3, 255);
  const depth = new Float32Array(W * H).fill(Infinity);

  // 用包围盒 8 个角点计算适配缩放
  const corners = [];
  for (const ax of [0, 1]) for (const ay of [0, 1]) for (const az of [0, 1])
    corners.push([gmn[0] + ax * (gmx[0] - gmn[0]) - center[0], gmn[1] + ay * (gmx[1] - gmn[1]) - center[1], gmn[2] + az * (gmx[2] - gmn[2]) - center[2]]);
  let exR = 0, exU = 0;
  for (const c of corners) { exR = Math.max(exR, Math.abs(dot(c, r))); exU = Math.max(exU, Math.abs(dot(c, u))); }
  const scale = Math.min(W / (2 * exR), H / (2 * exU)) * (opts.fill || 0.96);

  for (const pt of parts) {
    const base = palette ? palette[pt.mi] : pt.color.map(v => v * 255);
    for (let i = 0; i < pt.pos.length; i += 3) {
      const px = pt.pos[i] - center[0], py = pt.pos[i + 1] - center[1], pz = pt.pos[i + 2] - center[2];
      const X = (px * r[0] + py * r[1] + pz * r[2]) * scale + W / 2;
      const Y = H / 2 - (px * u[0] + py * u[1] + pz * u[2]) * scale;
      const Z = px * d[0] + py * d[1] + pz * d[2];
      let nx = pt.nrm[i], ny = pt.nrm[i + 1], nz = pt.nrm[i + 2];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      let sh = 0.30;
      for (const L of lights) sh += 0.42 * Math.max(0, -(nx * L[0] + ny * L[1] + nz * L[2]));
      sh = Math.min(1.18, sh);
      const cx = Math.round(X), cy = Math.round(Y);
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const x = cx + ox, y = cy + oy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = y * W + x;
        if (Z < depth[k]) {
          depth[k] = Z;
          rgb[k * 3] = Math.min(255, base[0] * sh);
          rgb[k * 3 + 1] = Math.min(255, base[1] * sh);
          rgb[k * 3 + 2] = Math.min(255, base[2] * sh);
        }
      }
    }
  }
  return rgb;
}

const W = 900, H = 720;
const outDir = process.argv[3] || 'scripts/_skin_render';
fs.mkdirSync(outDir, { recursive: true });

// 参考图视角：约 3/4 俯视侧后角
writePNG(`${outDir}/orig_isoL.png`, W, H, renderView(W, H, norm([0.75, -0.52, 0.62]), [0, 1, 0], null));
writePNG(`${outDir}/orig_isoR.png`, W, H, renderView(W, H, norm([-0.75, -0.52, 0.62]), [0, 1, 0], null));
writePNG(`${outDir}/orig_front.png`, W, H, renderView(W, H, [0, 0, 1], [0, 1, 0], null));
writePNG(`${outDir}/orig_top.png`, W, H, renderView(W, H, [0, -1, 0.001], [0, 0, 1], null));
writePNG(`${outDir}/orig_sideL.png`, W, H, renderView(W, H, [1, 0, 0], [0, 1, 0], null));

// 部件 ID 配色 + 逐部件隔离（3/4 视角）
const DISTINCT = [[230, 80, 60], [70, 150, 235], [80, 200, 90], [250, 215, 40], [185, 90, 220], [40, 210, 210], [250, 140, 40]];
const ISO = [norm([-0.75, -0.52, 0.62]), [0, 1, 0]];
writePNG(`${outDir}/ids_iso.png`, W, H, renderView(W, H, ISO[0], ISO[1], DISTINCT));
for (let i = 0; i < parts.length; i++) {
  const pal = DISTINCT.map(() => [225, 225, 225]);
  pal[i] = DISTINCT[i];
  const saved = parts.map(p => p.pos);
  parts.forEach((p, k) => { p.pos = k === i ? saved[k] : new Float32Array(0); });
  writePNG(`${outDir}/solo_iso_${i}.png`, W, H, renderView(W, H, ISO[0], ISO[1], pal));
  parts.forEach((p, k) => { p.pos = saved[k]; });
}
console.log('done', outDir);
