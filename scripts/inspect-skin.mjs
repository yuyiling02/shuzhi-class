import fs from 'node:fs';

const file = process.argv[2];
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart, binStart + b.readUInt32LE(16));

const COMP = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(idx) {
  const a = json.accessors[idx];
  const v = json.bufferViews[a.bufferView];
  const off = (v.byteOffset || 0) + (a.byteOffset || 0);
  const n = NUM[a.type];
  const sz = COMP[a.componentType];
  const stride = v.byteStride || n * sz;
  const out = new Float64Array(a.count * n);
  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < n; k++) {
      const p = off + i * stride + k * sz;
      out[i * n + k] =
        a.componentType === 5126 ? buf.readFloatLE(p) :
        a.componentType === 5125 ? buf.readUInt32LE(p) :
        a.componentType === 5123 ? buf.readUInt16LE(p) :
        a.componentType === 5121 ? buf.readUInt8(p) :
        buf.readInt16LE(p);
    }
  }
  return out;
}

function packColor(c, factor) {
  const to255 = x => Math.round(Math.min(1, Math.max(0, x * (factor ?? 1))) * 255);
  return `rgb(${to255(c[0])},${to255(c[1])},${to255(c[2])}) #${[0, 1, 2].map(i => to255(c[i]).toString(16).padStart(2, '0')).join('')}`;
}

console.log('=== GLB:', file.split(/[\\/]/).pop(), '=== meshes:', (json.meshes || []).length, 'materials:', (json.materials || []).length);
console.log('extensions:', JSON.stringify(json.extensionsUsed || []));

for (let mi = 0; mi < (json.meshes || []).length; mi++) {
  const mesh = json.meshes[mi];
  const node = (json.nodes || []).find(nd => nd.mesh === mi);
  const p = mesh.primitives[0];
  const pos = readAccessor(p.attributes.POSITION);
  const tri = p.indices !== undefined ? json.accessors[p.indices].count / 3 : pos.length / 9;

  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < mn[k]) mn[k] = pos[i + k];
      if (pos[i + k] > mx[k]) mx[k] = pos[i + k];
    }
  }
  const sz = mx.map((v, k) => v - mn[k]);
  const cen = mx.map((v, k) => (v + mn[k]) / 2);

  const mat = p.material !== undefined ? json.materials[p.material] : null;
  const pbr = mat && mat.pbrMetallicRoughness ? mat.pbrMetallicRoughness : {};
  const bc = pbr.baseColorFactor;
  const hasVC = p.attributes.COLOR_0 !== undefined;
  let vcRange = '';
  if (hasVC) {
    const vc = readAccessor(p.attributes.COLOR_0);
    const cmn = [Infinity, Infinity, Infinity], cmx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < vc.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        if (vc[i + k] < cmn[k]) cmn[k] = vc[i + k];
        if (vc[i + k] > cmx[k]) cmx[k] = vc[i + k];
      }
    }
    vcRange = ` COLOR_0 avg=(${[0, 1, 2].map(k => ((cmn[k] + cmx[k]) / 2).toFixed(3)).join(',')}) rawMin=${cmn.map(v => v.toFixed(3))} rawMax=${cmx.map(v => v.toFixed(3))} itemType=${json.accessors[p.attributes.COLOR_0].componentType}`;
  }
  const extras = node && node.extras ? JSON.stringify(node.extras) : '';
  console.log(`[${mi}] node=${node ? node.name : '?'} tris=${tri} verts=${json.accessors[p.attributes.POSITION].count}`);
  console.log(`     size=(${sz.map(v => v.toFixed(3)).join(', ')})  center=(${cen.map(v => v.toFixed(3)).join(', ')})`);
  console.log(`     yMin=${mn[1].toFixed(3)} yMax=${mx[1].toFixed(3)}`);
  console.log(`     material=${mat ? mat.name : 'NONE'} baseColor=${bc ? packColor(bc) : '(default white)'} metallic=${pbr.metallicFactor ?? 1} rough=${pbr.roughnessFactor ?? 1} attrs=${Object.keys(p.attributes).join(',')}`);
  if (vcRange) console.log(`    ${vcRange}`);
  if (extras) console.log(`     extras=${extras}`);
  if (node && node.translation) console.log(`     nodeTranslation=${JSON.stringify(node.translation)}`);
}
