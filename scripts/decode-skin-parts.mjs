import fs from 'node:fs';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.glb';
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));

const decoderModule = await draco3d.createDecoderModule({});
console.log('=== ', file.split(/[\\/]/).pop(), ': meshes', json.meshes.length, '===');

const results = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const mesh = json.meshes[mi];
  const p = mesh.primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const off = bv.byteOffset || 0;
  const dracoBuf = new decoderModule.DecoderBuffer();
  dracoBuf.Init(new Int8Array(buf.buffer, buf.byteOffset + off, bv.byteLength), bv.byteLength);
  const decoder = new decoderModule.Decoder();
  const geomType = decoder.GetEncodedGeometryType(dracoBuf);
  const dracoMesh = new decoderModule.Mesh();
  decoder.DecodeBufferToMesh(dracoBuf, dracoMesh);
  if (!dracoMesh.ptr) { console.log('mesh', mi, 'DECODE FAIL', decoder.GetErrorMsg(dracoMesh)); continue; }

  const numPts = dracoMesh.num_points();
  const numFaces = dracoMesh.num_faces();

  const readAttr = (uniqueId) => {
    const attr = decoder.GetAttributeByUniqueId(dracoMesh, uniqueId);
    const n = attr.num_components();
    const arr = new decoderModule.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(dracoMesh, attr, arr);
    const out = new Float32Array(numPts * n);
    for (let i = 0; i < out.length; i++) out[i] = arr.GetValue(i);
    decoderModule.destroy(arr);
    return { data: out, n };
  };

  const posId = ext.attributes.POSITION;
  const { data: pos } = readAttr(posId);
  const { data: nrm } = readAttr(ext.attributes.NORMAL);

  // bbox
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < mn[k]) mn[k] = pos[i + k];
      if (pos[i + k] > mx[k]) mx[k] = pos[i + k];
    }
  const sz = mx.map((v, k) => v - mn[k]);
  const cen = mx.map((v, k) => (v + mn[k]) / 2);

  // 归一化高度分布：把 y 分成10层，统计每层顶点占比
  const NB = 10;
  const hist = new Array(NB).fill(0);
  for (let i = 1; i < pos.length; i += 3) {
    let t = sz[1] > 0 ? (pos[i] - mn[1]) / sz[1] : 0;
    hist[Math.min(NB - 1, Math.max(0, Math.floor(t * NB)))]++;
  }
  const histPct = hist.map(v => Math.round((v / numPts) * 100));

  // 主方向：PCA 粗略地看形状是否细长（用 xz 平面半径与 y 高度比）
  const mat = json.materials[p.material];
  const bc = mat.pbrMetallicRoughness.baseColorFactor;
  const hex = '#' + bc.slice(0, 3).map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');

  results.push({ mi, name: mesh.name, matName: mat.name, hex, bc, tris: numFaces, verts: numPts, mn, mx, sz, cen, histPct });
  console.log(`[${mi}] ${mesh.name}  mat=${mat.name}  color=${hex} rgb(${bc.slice(0,3).map(v=>Math.round(v*255)).join(',')})`);
  console.log(`     tris=${numFaces} verts=${numPts}`);
  console.log(`     size=(${sz.map(v => v.toFixed(4)).join(', ')})`);
  console.log(`     y: ${mn[1].toFixed(4)} .. ${mx[1].toFixed(4)}   center=(${cen.map(v => v.toFixed(4)).join(', ')})`);
  console.log(`     yHist%(bottom->top)=[${histPct.join(',')}]`);
}

fs.writeFileSync('scripts/_skin_parts.json', JSON.stringify(results.map(r => ({ ...r, mn: r.mn, mx: r.mx })), null, 1));
