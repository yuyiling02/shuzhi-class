import fs from 'node:fs';
import draco3d from 'draco3d';

const b = fs.readFileSync(process.argv[2] || 'public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const decoderModule = await draco3d.createDecoderModule({});

const parts = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new decoderModule.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new decoderModule.Decoder();
  const dm = new decoderModule.Mesh();
  dec.DecodeBufferToMesh(db, dm);
  const n = dm.num_points();
  const attr = dec.GetAttributeByUniqueId(dm, ext.attributes.POSITION);
  const arr = new decoderModule.DracoFloat32Array();
  dec.GetAttributeFloatForAllPoints(dm, attr, arr);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = arr.GetValue(i);
  parts.push({ mi, name: json.meshes[mi].name, pos, n });
}

// 全局范围
let gmn = [Infinity, Infinity, Infinity], gmx = [-Infinity, -Infinity, -Infinity];
for (const pt of parts) for (let i = 0; i < pt.pos.length; i += 3)
  for (let k = 0; k < 3; k++) {
    if (pt.pos[i + k] < gmn[k]) gmn[k] = pt.pos[i + k];
    if (pt.pos[i + k] > gmx[k]) gmx[k] = pt.pos[i + k];
  }
console.log('GLOBAL  x', gmn[0].toFixed(3), gmx[0].toFixed(3), '| y', gmn[1].toFixed(3), gmx[1].toFixed(3), '| z', gmn[2].toFixed(3), gmx[2].toFixed(3));

const glyphs = '0123456789ABCDEF';

function project(axisA, axisB, label, W = 88, H = 34, which = null) {
  const a0 = gmn[axisA], a1 = gmx[axisA], b0 = gmn[axisB], b1 = gmx[axisB];
  const grid = Array.from({ length: H }, () => new Array(W).fill('.'));
  const seen = Array.from({ length: H }, () => new Array(W).fill(false));
  const order = which === null ? parts.map((_, i) => i) : [which];
  for (const pi of order) {
    const pt = parts[pi];
    const g = which === null ? glyphs[pi] : '#';
    for (let i = 0; i < pt.pos.length; i += 3) {
      const u = Math.min(W - 1, Math.max(0, Math.floor(((pt.pos[i + axisA] - a0) / (a1 - a0)) * W)));
      const v = Math.min(H - 1, Math.max(0, Math.floor(((b1 - pt.pos[i + axisB]) / (b1 - b0)) * H)));
      grid[v][u] = g;
    }
  }
  console.log(`\n--- ${label}  (horiz=${'xyz'[axisA]}, vert=${'xyz'[axisB]}) ---`);
  grid.forEach(row => console.log(row.join('')));
}

project(2, 1, '侧视图 Y-Z（z 向右，y 向上）');
project(0, 2, '俯视图 X-Z（x 向右，z 向上）');

console.log('\n=== 每个部件单独侧视 Y-Z ===');
for (let i = 0; i < parts.length; i++) project(2, 1, `part_${i}`, 88, 20, i);
