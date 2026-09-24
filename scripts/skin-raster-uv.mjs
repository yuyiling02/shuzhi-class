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

/* ---------- 贴图 ---------- */
const TW = Number(process.env.ATLAS_SIZE || 2048), TH = TW;
const atlas = fs.readFileSync(process.env.ATLAS_FILE || 'scripts/_atlas.raw');
function texSample(u, v, out) {
  let x = Math.floor(u * TW) % TW; if (x < 0) x += TW;
  let y = Math.floor(v * TH) % TH; if (y < 0) y += TH;
  const o = (y * TW + x) * 3;
  out[0] = atlas[o]; out[1] = atlas[o + 1]; out[2] = atlas[o + 2];
}

/* ---------- GLB ---------- */
const glbPath = process.argv[2] || 'public/models/organ-skin.glb';
const b = fs.readFileSync(glbPath);
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
  const n = mesh.num_points(), nf = mesh.num_faces();
  const get = (uid, c) => { const a = dec.GetAttributeByUniqueId(mesh, uid); const arr = new dmod.DracoFloat32Array(); dec.GetAttributeFloatForAllPoints(mesh, a, arr); const o = new Float32Array(n * c); for (let i = 0; i < o.length; i++) o[i] = arr.GetValue(i); return o; };
  const farr = new dmod.DracoInt32Array();
  const idx = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) { dec.GetFaceFromMesh(mesh, f, farr); idx[f * 3] = farr.GetValue(0); idx[f * 3 + 1] = farr.GetValue(1); idx[f * 3 + 2] = farr.GetValue(2); }
  parts.push({
    mi, name: json.meshes[mi].name, n, nf, idx,
    pos: get(ext.attributes.POSITION, 3),
    nrm: get(ext.attributes.NORMAL, 3),
    uv: ext.attributes.TEXCOORD_0 !== undefined ? get(ext.attributes.TEXCOORD_0, 2) : null,
    color: json.materials[p.material].pbrMetallicRoughness.baseColorFactor.slice(0, 3),
  });
  // UV 统计
  if (parts[mi].uv) {
    const uv = parts[mi].uv;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let i = 0; i < uv.length; i += 2) { u0 = Math.min(u0, uv[i]); u1 = Math.max(u1, uv[i]); v0 = Math.min(v0, uv[i + 1]); v1 = Math.max(v1, uv[i + 1]); }
    console.log(`[${mi}] ${parts[mi].name} UV u:${u0.toFixed(3)}..${u1.toFixed(3)}  v:${v0.toFixed(3)}..${v1.toFixed(3)}`);
  }
}
const gmn = [Infinity, Infinity, Infinity], gmx = [-Infinity, -Infinity, -Infinity];
for (const pt of parts) for (let i = 0; i < pt.pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pt.pos[i + k] < gmn[k]) gmn[k] = pt.pos[i + k]; if (pt.pos[i + k] > gmx[k]) gmx[k] = pt.pos[i + k]; }
const center = gmn.map((v, k) => (v + gmx[k]) / 2);
const norm = (v) => { const l = Math.hypot(...v); return v.map(x => x / l); };
const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]];
const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];

function renderUV(W, H, viewDir, upHint, mode) {
  const d = norm(viewDir);
  const r = norm(cross(upHint, d));
  const u = norm(cross(d, r));
  const L = norm([-0.45, 0.75, 0.55]);
  const rgb = Buffer.alloc(W * H * 3, 255);
  const zb = new Float32Array(W * H).fill(Infinity);
  const corners = [];
  for (const ax of [0, 1]) for (const ay of [0, 1]) for (const az of [0, 1])
    corners.push([gmn[0] + ax * (gmx[0] - gmn[0]) - center[0], gmn[1] + ay * (gmx[1] - gmn[1]) - center[1], gmn[2] + az * (gmx[2] - gmn[2]) - center[2]]);
  let eR = 0, eU = 0;
  for (const c of corners) { eR = Math.max(eR, Math.abs(dot(c, r))); eU = Math.max(eU, Math.abs(dot(c, u))); }
  const s = Math.min(W / (2 * eR), H / (2 * eU)) * 0.96;
  const proj = (px, py, pz) => { const x = px - center[0], y = py - center[1], z = pz - center[2]; return [dot([x, y, z], r) * s + W / 2, H / 2 - dot([x, y, z], u) * s, dot([x, y, z], d)]; };
  const tc = [0, 0, 0];
  for (const pt of parts) {
    const { pos, nrm, uv, idx } = pt;
    const flat = pt.color.map(v => v * 255);
    for (let f = 0; f < idx.length; f += 3) {
      const a = idx[f], c = idx[f + 1], e = idx[f + 2];
      const P = [proj(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]), proj(pos[c * 3], pos[c * 3 + 1], pos[c * 3 + 2]), proj(pos[e * 3], pos[e * 3 + 1], pos[e * 3 + 2])];
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
      if (area >= 0) continue;
      const minX = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
      const minY = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
      if (maxX < minX || maxY < minY) continue;
      const nx = (nrm[a * 3] + nrm[c * 3] + nrm[e * 3]) / 3, ny = (nrm[a * 3 + 1] + nrm[c * 3 + 1] + nrm[e * 3 + 1]) / 3, nz = (nrm[a * 3 + 2] + nrm[c * 3 + 2] + nrm[e * 3 + 2]) / 3;
      const nl = Math.hypot(nx, ny, nz) || 1;
      let sh = 0.55 + 0.55 * Math.max(0, -(nx * L[0] + ny * L[1] + nz * L[2]) / nl);
      sh = Math.min(1.12, sh);
      const inv = 1 / (area || -1e-9);
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[1][1] - py) * (P[2][0] - px)) * inv;
        const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[2][1] - py) * (P[0][0] - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
        const k = y * W + x;
        if (z < zb[k]) {
          zb[k] = z;
          let br = flat[0], bg = flat[1], bb = flat[2];
          if (mode === 'uv' && uv) {
            texSample(w0 * uv[a * 2] + w1 * uv[c * 2] + w2 * uv[e * 2], w0 * uv[a * 2 + 1] + w1 * uv[c * 2 + 1] + w2 * uv[e * 2 + 1], tc);
            br = tc[0]; bg = tc[1]; bb = tc[2];
          }
          rgb[k * 3] = Math.min(255, br * sh);
          rgb[k * 3 + 1] = Math.min(255, bg * sh);
          rgb[k * 3 + 2] = Math.min(255, bb * sh);
        }
      }
    }
  }
  return rgb;
}

const W = 900, H = 720;
const outDir = 'scripts/_skin_render';
const iso = norm([-0.75, -0.52, 0.62]);
const isoL = norm([0.75, -0.52, 0.62]);
writePNG(`${outDir}/tex_iso.png`, W, H, renderUV(W, H, iso, [0, 1, 0], 'uv'));
writePNG(`${outDir}/tex_isoL.png`, W, H, renderUV(W, H, isoL, [0, 1, 0], 'uv'));
writePNG(`${outDir}/uvcheck_iso.png`, W, H, renderUV(W, H, iso, [0, 1, 0], 'uv'));
const top = norm([0, -1, 0]);
writePNG(`${outDir}/tex_top.png`, W, H, renderUV(W, H, top, [0, 0, 1], 'uv'));
console.log('done');
