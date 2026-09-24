import fs from 'node:fs';
import draco3d from 'draco3d';

const TW = 2048, TH = 2048;
const atlas = fs.readFileSync('scripts/_atlas.raw');

const b = fs.readFileSync(process.argv[2] || 'public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const g = new Uint8Array(TW * TH);          // bitmask of parts covering this texel
const acc = new Int32Array(TW * TH * 3);    // 累加颜色 (valid only)
const cnt = new Int32Array(TW * TH);

const isBlack = (r, c, bl) => (r + c + bl) < 90;

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
  const uv = get(ext.attributes.TEXCOORD_0, 2);

  const mask = 1 << mi;
  let covered = 0, blackTexels = 0;
  const sum = [0, 0, 0]; let good = 0;

  for (let f = 0; f < idx.length; f += 3) {
    const a = idx[f], c = idx[f + 1], e = idx[f + 2];
    const U = [uv[a * 2] * TW, uv[c * 2] * TW, uv[e * 2] * TW];
    const V = [uv[a * 2 + 1] * TH, uv[c * 2 + 1] * TH, uv[e * 2 + 1] * TH];
    const minX = Math.max(0, Math.floor(Math.min(...U))), maxX = Math.min(TW - 1, Math.ceil(Math.max(...U)));
    const minY = Math.max(0, Math.floor(Math.min(...V))), maxY = Math.min(TH - 1, Math.ceil(Math.max(...V)));
    if (maxX - minX > 400 || maxY - minY > 400) continue; // 跳过跨岛的退化三角
    if (maxX < minX || maxY < minY) continue;
    const area = (U[1] - U[0]) * (V[2] - V[0]) - (V[1] - V[0]) * (U[2] - U[0]);
    if (Math.abs(area) < 1e-6) continue;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((U[1] - px) * (V[2] - py) - (V[1] - py) * (U[2] - px)) * inv;
      const w1 = ((U[2] - px) * (V[0] - py) - (V[2] - py) * (U[0] - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.02 || w1 < -0.02 || w2 < -0.02) continue;
      const k = y * TW + x;
      g[k] |= mask;
      covered++;
      const o = k * 3;
      if (isBlack(atlas[o], atlas[o + 1], atlas[o + 2])) { blackTexels++; }
      else { sum[0] += atlas[o]; sum[1] += atlas[o + 1]; sum[2] += atlas[o + 2]; good++; }
    }
  }

  const avg = good > 0 ? sum.map(v => Math.round(v / good)) : [0, 0, 0];
  const hex = '#' + avg.map(v => v.toString(16).padStart(2, '0')).join('');
  console.log(`[${mi}] ${json.meshes[mi].name}  texels=${covered}  黑色占比=${(blackTexels / Math.max(1, covered) * 100).toFixed(1)}%  有效像素均值=rgb(${avg.join(',')}) ${hex}`);
}

// 统计全局被覆盖比例
let coveredTotal = 0;
for (let i = 0; i < g.length; i++) if (g[i]) coveredTotal++;
console.log(`图谱覆盖率: ${(coveredTotal / g.length * 100).toFixed(1)}%`);
