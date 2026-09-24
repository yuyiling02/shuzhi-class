import fs from 'node:fs';
import draco3d from 'draco3d';

const b = fs.readFileSync(process.argv[2] || 'public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dm = await draco3d.createDecoderModule({});

for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dm.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dm.Decoder(); const mesh = new dm.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  const n = mesh.num_points(); const nf = mesh.num_faces();

  const attr = dec.GetAttributeByUniqueId(mesh, ext.attributes.POSITION);
  const arr = new dm.DracoFloat32Array();
  dec.GetAttributeFloatForAllPoints(mesh, attr, arr);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = arr.GetValue(i);

  // 索引（draco 存储的是 point index 映射）
  const idxMap = new Int32Array(n);
  const ia = dec.GetAttributeByUniqueId(mesh, ext.attributes.POSITION);
  const iarr = new dm.DracoInt32Array();
  dec.GetAttributeInt32ForAllPoints(mesh, ia, iarr);
  for (let i = 0; i < n; i++) idxMap[i] = iarr.GetValue(i);

  const face = new dm.DracoInt32Array();
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, c) => { const ra = find(a), rc = find(c); if (ra !== rc) parent[ra] = rc; };

  let surface = 0;
  for (let f = 0; f < nf; f++) {
    dec.GetFaceFromMesh(mesh, f, face);
    const a = face.GetValue(0), c = face.GetValue(1), d = face.GetValue(2);
    uni(a, c); uni(c, d);
    // 面积
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[c * 3] - ax, by = pos[c * 3 + 1] - ay, bz = pos[c * 3 + 2] - az;
    const cx = pos[d * 3] - ax, cy = pos[d * 3 + 1] - ay, cz = pos[d * 3 + 2] - az;
    const nx = by * cz - bz * cy, ny = bz * cx - bx * cz, nz = bx * cy - by * cx;
    surface += 0.5 * Math.hypot(nx, ny, nz);
  }

  const roots = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); roots.set(r, (roots.get(r) || 0) + 1); }
  const sizes = [...roots.values()].sort((a, c) => c - a);
  const big = sizes.filter(s => s > n * 0.001);

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { if (pos[i + k] < mn[k]) mn[k] = pos[i + k]; if (pos[i + k] > mx[k]) mx[k] = pos[i + k]; }
  const vol = (mx[0] - mn[0]) * (mx[1] - mn[1]) * (mx[2] - mn[2]);

  console.log(`[${mi}] ${json.meshes[mi].name}  verts=${n} tris=${nf} components=${sizes.length} (major=${big.length})`);
  console.log(`     bboxVol=${vol.toFixed(4)} surface=${surface.toFixed(4)}  S/V^(2/3)=${(surface / Math.pow(vol, 2 / 3)).toFixed(2)}  S/Cbrt(V)=${(surface / Math.cbrt(vol)).toFixed(2)}`);
  console.log(`     component vertex counts (top10)=[${sizes.slice(0, 10).join(', ')}]`);
}
