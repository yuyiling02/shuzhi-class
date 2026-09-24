import fs from 'node:fs';
import zlib from 'node:zlib';
import draco3d from 'draco3d';

const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'ascii'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
function writePNG(file, W, H, rgb) { const raw = Buffer.alloc((W * 3 + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); } const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 2; fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])); }

const TW = 2048, TH = 2048;
const atlas = fs.readFileSync('scripts/_atlas.raw');
const b = fs.readFileSync('public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const targets = process.argv.slice(2).map(Number);
const W = 420, H = 420;

for (const mi of targets) {
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
  const uv = get(ext.attributes.TEXCOORD_0, 2);

  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < uv.length; i += 2) { if (uv[i] < u0) u0 = uv[i]; if (uv[i] > u1) u1 = uv[i]; if (uv[i + 1] < v0) v0 = uv[i + 1]; if (uv[i + 1] > v1) v1 = uv[i + 1]; }
  const pad = 0.02, du = (u1 - u0) * (1 + 2 * pad) || 1, dv = (v1 - v0) * (1 + 2 * pad) || 1;

  const rgb = Buffer.alloc(W * H * 3, 255);
  const zb = new Float32Array(W * H).fill(Infinity);
  const zbT = new Float32Array(W * H).fill(Infinity);
  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], c = idx[f + 1], e = idx[f + 2];
    const P = [a, c, e].map(k => [(uv[k * 2] - u0 + pad * du) / du * W, (1 - (uv[k * 2 + 1] - v0 + pad * dv) / dv) * H]);
    const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0]);
    if (Math.abs(area) < 1e-6) continue;
    const minX = Math.max(0, Math.floor(Math.min(...P.map(q => q[0])))), maxX = Math.min(W - 1, Math.ceil(Math.max(...P.map(q => q[0]))));
    const minY = Math.max(0, Math.floor(Math.min(...P.map(q => q[1])))), maxY = Math.min(H - 1, Math.ceil(Math.max(...P.map(q => q[1]))));
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[1][1] - py) * (P[2][0] - px)) * inv;
      const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[2][1] - py) * (P[0][0] - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const k = y * W + x;
      zb[k] = 1;
      const tx = Math.floor((w0 * uv[a * 2] + w1 * uv[c * 2] + w2 * uv[e * 2]) * TW) % TW;
      const ty = Math.floor((w0 * uv[a * 2 + 1] + w1 * uv[c * 2 + 1] + w2 * uv[e * 2 + 1]) * TH) % TH;
      const o = (ty * TW + tx) * 3;
      rgb[k * 3] = atlas[o]; rgb[k * 3 + 1] = atlas[o + 1]; rgb[k * 3 + 2] = atlas[o + 2];
    }
  }
  writePNG(`scripts/_skin_render/uvflat_${mi}.png`, W, H, rgb);
  console.log(`part_${mi} uvflat written  (u ${u0.toFixed(3)}..${u1.toFixed(3)}, v ${v0.toFixed(3)}..${v1.toFixed(3)})`);
}
