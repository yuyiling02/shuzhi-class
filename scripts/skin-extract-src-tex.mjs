/**
 * 从 output/organ-skin-pbr-src.glb 抽出每个部件的 baseColor 贴图，
 * 并输出几何摘要用于和 public/models/organ-skin.glb 比对。
 */
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2] || 'output/organ-skin-pbr-src.glb';
const outDir = process.argv[3] || 'scripts/_skin_src';
fs.mkdirSync(outDir, { recursive: true });

const b = fs.readFileSync(src);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));

function accessor(ai) {
  const a = json.accessors[ai];
  const bv = json.bufferViews[a.bufferView];
  const off = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const n = a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type]);
  let arr;
  if (a.componentType === 5126) arr = new Float32Array(buf.buffer, buf.byteOffset + off, n);
  else if (a.componentType === 5125) arr = new Uint32Array(buf.buffer, buf.byteOffset + off, n);
  else if (a.componentType === 5123) arr = new Uint16Array(buf.buffer, buf.byteOffset + off, n);
  else throw new Error('componentType ' + a.componentType);
  return { arr, n, type: a.type, count: a.count };
}

console.log(`=== ${path.basename(src)} ===`);
const manifest = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const prim = json.meshes[mi].primitives[0];
  const mat = json.materials[prim.material];
  const bcTex = mat.pbrMetallicRoughness?.baseColorTexture?.index;
  const bcImg = bcTex !== undefined ? json.textures[bcTex].source : undefined;
  const pos = accessor(prim.attributes.POSITION);
  const idx = prim.indices !== undefined ? accessor(prim.indices) : null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.n; i += 3) for (let k = 0; k < 3; k++) {
    const v = pos.arr[i + k];
    if (v < mn[k]) mn[k] = v;
    if (v > mx[k]) mx[k] = v;
  }
  const tri = idx ? idx.n / 3 : 0;
  const img = bcImg !== undefined ? json.images[bcImg] : null;
  let file = null, bytes = 0;
  if (img) {
    const bv = json.bufferViews[img.bufferView];
    const off = bv.byteOffset || 0;
    const data = buf.subarray(off, off + bv.byteLength);
    const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
    file = `${outDir}/part_${mi}_basecolor.${ext}`;
    fs.writeFileSync(file, data);
    bytes = data.length;
    // 顺带抽 normal / mr 备用
    for (const [key, val] of [['normal', mat.normalTexture?.index], ['mr', mat.pbrMetallicRoughness?.metallicRoughnessTexture?.index]]) {
      if (val === undefined) continue;
      const im2 = json.images[json.textures[val].source];
      const bv2 = json.bufferViews[im2.bufferView];
      const d2 = buf.subarray(bv2.byteOffset || 0, (bv2.byteOffset || 0) + bv2.byteLength);
      fs.writeFileSync(`${outDir}/part_${mi}_${key}.${im2.mimeType === 'image/png' ? 'png' : 'jpg'}`, d2);
    }
  }
  console.log(
    `[${mi}] mesh=${json.meshes[mi].name} mat=${mat.name} verts=${pos.count} tris=${tri} ` +
    `bbox=(${(mx[0] - mn[0]).toFixed(3)},${(mx[1] - mn[1]).toFixed(3)},${(mx[2] - mn[2]).toFixed(3)}) ` +
    `y=[${mn[1].toFixed(3)},${mx[1].toFixed(3)}]  baseColorImg=${bcImg} (${(bytes / 1024).toFixed(0)}KB)`
  );
  manifest.push({ mi, mesh: json.meshes[mi].name, mat: mat.name, verts: pos.count, tris: tri, img: bcImg, file, mn, mx });
}
fs.writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 1));
console.log('图片清单:', JSON.stringify(json.images.map((im, i) => ({ i, n: im.name, mime: im.mimeType })), null, 0));
