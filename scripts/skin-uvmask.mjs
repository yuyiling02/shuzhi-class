/**
 * 把 7 个部件按其 UV 光栅化到图集空间，生成：
 *   scripts/_skin_src/uvmask_u8.raw  每 texel 的部件号（0=未覆盖, 1..7=part_0..6）
 *   scripts/_skin_src/uvmask_ov.raw  每 texel 被几个部件覆盖（>1 表示冲突）
 * 并打印重叠统计。
 *
 * 用法：node scripts/skin-uvmask.mjs [glb] [size]
 */
import fs from 'node:fs';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.original.glb';
const S = Number(process.argv[3] || 2048);
const outDir = 'scripts/_skin_src';
fs.mkdirSync(outDir, { recursive: true });

const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dm = await draco3d.createDecoderModule({});

const id = new Uint8Array(S * S);
const ov = new Uint8Array(S * S);
const perPart = [];

for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dm.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dm.Decoder(); const mesh = new dm.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  const n = mesh.num_points(), nf = mesh.num_faces();
  const uvA = dec.GetAttributeByUniqueId(mesh, ext.attributes.TEXCOORD_0);
  const uvArr = new dm.DracoFloat32Array();
  dec.GetAttributeFloatForAllPoints(mesh, uvA, uvArr);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < uv.length; i++) uv[i] = uvArr.GetValue(i);
  const farr = new dm.DracoInt32Array();
  const idx = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) { dec.GetFaceFromMesh(mesh, f, farr); idx[f * 3] = farr.GetValue(0); idx[f * 3 + 1] = farr.GetValue(1); idx[f * 3 + 2] = farr.GetValue(2); }

  const pid = mi + 1;
  let covered = 0, conflict = 0;
  for (let f = 0; f < nf; f++) {
    const a = idx[f * 3], c = idx[f * 3 + 1], e = idx[f * 3 + 2];
    const U = [uv[a * 2] * S, uv[c * 2] * S, uv[e * 2] * S];
    const V = [uv[a * 2 + 1] * S, uv[c * 2 + 1] * S, uv[e * 2 + 1] * S];
    const minX = Math.max(0, Math.floor(Math.min(...U))), maxX = Math.min(S - 1, Math.ceil(Math.max(...U)));
    const minY = Math.max(0, Math.floor(Math.min(...V))), maxY = Math.min(S - 1, Math.ceil(Math.max(...V)));
    if (maxX - minX > S * 0.25 || maxY - minY > S * 0.25) continue;   // 跨岛退化三角
    const area = (U[1] - U[0]) * (V[2] - V[0]) - (V[1] - V[0]) * (U[2] - U[0]);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      const w0 = ((U[1] - px) * (V[2] - py) - (V[1] - py) * (U[2] - px)) * inv;
      const w1 = ((U[2] - px) * (V[0] - py) - (V[2] - py) * (U[0] - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const k = y * S + x;
      if (id[k] && id[k] !== pid) ov[k] = 1;
      id[k] = pid;
      covered++;
    }
  }
  for (let k = 0; k < id.length; k++) if (ov[k]) conflict++;
  perPart.push({ mi, name: json.meshes[mi].name, covered });
  console.log(`[${mi}] ${json.meshes[mi].name}  覆盖 texel 累计=${covered}`);
}

let covered = 0, overlapTexels = 0;
for (let k = 0; k < id.length; k++) { if (id[k]) covered++; if (ov[k]) overlapTexels++; }
console.log(`\n图集 ${S}x${S}: 覆盖 ${(covered / id.length * 100).toFixed(1)}%  多部件重叠 texel=${overlapTexels} (${(overlapTexels / id.length * 100).toFixed(2)}%)`);
fs.writeFileSync(`${outDir}/uvmask_u8.raw`, id);
fs.writeFileSync(`${outDir}/uvmask_ov.raw`, ov);
fs.writeFileSync(`${outDir}/uvmask_size.json`, JSON.stringify({ S, covered, overlapTexels, perPart }, null, 1));
