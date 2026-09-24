/**
 * 导出皮肤模型各部件的顶点数据（位置 + UV），供 Python 在 3D 空间生成血管管网。
 *
 * 输出 scripts/_skin_verts/part{mi}.f32
 *   每顶点 5 个 float32：[x, y, z, u, v]
 * 以及 scripts/_skin_verts/meta.json（顶点数、bbox）
 *
 * 用法：node scripts/skin-dump-verts.mjs [glb]
 */
import fs from 'node:fs';
import path from 'node:path';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.original.glb';
const outDir = 'scripts/_skin_verts';
fs.mkdirSync(outDir, { recursive: true });

const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dm = await draco3d.createDecoderModule({});

const meta = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dm.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dm.Decoder(); const mesh = new dm.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  const n = mesh.num_points();

  const readF = (uniqueId, comps) => {
    const attr = dec.GetAttributeByUniqueId(mesh, uniqueId);
    const arr = new dm.DracoFloat32Array();
    dec.GetAttributeFloatForAllPoints(mesh, attr, arr);
    const out = new Float32Array(n * comps);
    for (let i = 0; i < out.length; i++) out[i] = arr.GetValue(i);
    return out;
  };

  const pos = readF(ext.attributes.POSITION, 3);
  const uv = ext.attributes.TEXCOORD_0 !== undefined ? readF(ext.attributes.TEXCOORD_0, 2) : new Float32Array(n * 2);

  const rec = new Float32Array(n * 5);
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = pos[i * 3 + k];
      rec[i * 5 + k] = v;
      if (v < mn[k]) mn[k] = v;
      if (v > mx[k]) mx[k] = v;
    }
    rec[i * 5 + 3] = uv[i * 2];
    rec[i * 5 + 4] = uv[i * 2 + 1];
  }
  fs.writeFileSync(path.join(outDir, `part${mi}.f32`), Buffer.from(rec.buffer));
  meta.push({ part: mi, verts: n, mn, mx });
  console.log(`part_${mi}  verts=${n}  bbox=[${mn.map(v => v.toFixed(3))}] .. [${mx.map(v => v.toFixed(3))}]`);
}
fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1));
console.log('wrote', outDir);
