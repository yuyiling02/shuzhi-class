import fs from 'node:fs';
import path from 'node:path';

/**
 * 给 organ-skin 系列 GLB 的 7 个部件材质写入解剖学配色。
 * 用法: node scripts/skin-recolor.mjs <in.glb> [out.glb]
 */

// 解剖学配色：按 mesh 顺序 part_0 .. part_6
const PALETTE = [
  { part: 'part_0', anatomy: '皮下组织（脂肪层 / hypodermis）', hex: '#EFD264', roughness: 0.85, metallic: 0 },
  { part: 'part_1', anatomy: '真皮层（dermis）',                hex: '#E3A494', roughness: 0.80, metallic: 0 },
  { part: 'part_2', anatomy: '皮脂腺 / 汗腺（腺体）',            hex: '#F4E7C4', roughness: 0.75, metallic: 0 },
  { part: 'part_3', anatomy: '毛发（毛干 + 毛球）',              hex: '#4A2B17', roughness: 0.45, metallic: 0 },
  { part: 'part_4', anatomy: '表皮层（epidermis）',              hex: '#F3DCC0', roughness: 0.85, metallic: 0 },
  { part: 'part_5', anatomy: '毛囊（真皮内毛根鞘）',              hex: '#8A5433', roughness: 0.60, metallic: 0 },
  { part: 'part_6', anatomy: '毛干（露出皮肤部分）',              hex: '#402513', roughness: 0.45, metallic: 0 },
];

const hexToLinearRgb = (hex) => {
  const n = hex.replace('#', '');
  const srgb = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  // glTF baseColorFactor 为线性空间
  const lin = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return lin.map((v) => Math.round(v * 1e6) / 1e6);
};

function readGlb(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB: ' + file);
  const jsonLen = b.readUInt32LE(12);
  const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/, '').trimEnd());
  const binStart = 20 + jsonLen;
  let bin = null;
  if (binStart + 8 <= b.length) {
    const binLen = b.readUInt32LE(binStart);
    bin = b.subarray(binStart + 8, binStart + 8 + binLen);
  }
  return { json, bin };
}

function writeGlb(file, json, bin) {
  let jsonStr = JSON.stringify(json);
  while (Buffer.byteLength(jsonStr, 'utf8') % 4 !== 0) jsonStr += ' ';
  const jsonBuf = Buffer.from(jsonStr, 'utf8');
  const chunks = [];
  const h1 = Buffer.alloc(8);
  h1.writeUInt32LE(jsonBuf.length, 0); h1.writeUInt32LE(0x4e4f534a, 4);
  chunks.push(h1, jsonBuf);
  if (bin) {
    let binBuf = bin;
    if (binBuf.length % 4 !== 0) binBuf = Buffer.concat([binBuf, Buffer.alloc(4 - (binBuf.length % 4))]);
    const h2 = Buffer.alloc(8);
    h2.writeUInt32LE(binBuf.length, 0); h2.writeUInt32LE(0x004e4942, 4);
    chunks.push(h2, binBuf);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + body.length, 8);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

function patch(file, outFile) {
  const { json, bin } = readGlb(file);
  const applied = [];
  for (let mi = 0; mi < json.meshes.length; mi++) {
    const mesh = json.meshes[mi];
    const desired = PALETTE[mi % PALETTE.length];
    for (const prim of mesh.primitives) {
      if (prim.material === undefined) continue;
      const mat = json.materials[prim.material];
      mat.pbrMetallicRoughness = mat.pbrMetallicRoughness || {};
      mat.pbrMetallicRoughness.baseColorFactor = [...hexToLinearRgb(desired.hex), 1];
      mat.pbrMetallicRoughness.metallicFactor = desired.metallic;
      mat.pbrMetallicRoughness.roughnessFactor = desired.roughness;
      applied.push(`${mesh.name} / ${mat.name} -> ${desired.hex} (${desired.anatomy})`);
    }
  }
  writeGlb(outFile, json, bin);
  return applied;
}

const inFile = process.argv[2];
const outFile = process.argv[3] || inFile;
const applied = patch(inFile, outFile);
console.log(`已写入 ${path.basename(outFile)}:`);
applied.forEach((a) => console.log('  ' + a));
