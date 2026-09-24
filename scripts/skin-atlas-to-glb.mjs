/**
 * 把重绘好的图集贴图写进皮肤模型 GLB：
 *   - 复用 GLB 内已有的 image 0 / textures[0..6]（原本是没人引用的孤儿资源），只替换图片数据
 *   - 7 个材质的 baseColorTexture 指向同一张图集，baseColorFactor 置白（颜色已烘焙进贴图）
 *   - 重建 BIN chunk，重算所有 bufferView 偏移
 *
 * 用法：node scripts/skin-atlas-to-glb.mjs <in.glb> <atlas.png> <out.glb>
 */
import fs from 'node:fs';

const [, , inGlb, atlasFile, outGlb] = process.argv;
if (!inGlb || !atlasFile || !outGlb) {
  console.error('用法: node scripts/skin-atlas-to-glb.mjs <in.glb> <atlas.png> <out.glb>');
  process.exit(1);
}

const pad4 = (n) => (n + 3) & ~3;

const b = fs.readFileSync(inGlb);
if (b.readUInt32LE(0) !== 0x46546c67) throw new Error('不是 GLB 文件');
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, '').replace(/ +$/g, ''));
let binStart = 20 + jsonLen;
if (b.readUInt32LE(binStart + 4) !== 0x004e4942) throw new Error('未找到 BIN chunk');
const binLen = b.readUInt32LE(binStart);
const oldBin = b.subarray(binStart + 8, binStart + 8 + binLen);

const atlas = fs.readFileSync(atlasFile);

/* 取出除 image 之外的 bufferView 数据（bv0 是旧图片） */
const views = json.bufferViews.map((v, i) => {
  let off = v.byteOffset;
  if (off === undefined) {
    off = 0;
    for (let k = 0; k < i; k++) off += json.bufferViews[k].byteLength;
  }
  return { i, data: oldBin.subarray(off, off + v.byteLength), byteLength: v.byteLength };
});

/* 新 BIN：图片 + 其余视图（4 字节对齐） */
const chunks = [];
let cursor = 0;
const newOffsets = {};
const pushChunk = (data) => {
  const padded = pad4(data.length);
  const buf = Buffer.alloc(padded, 0);
  data.copy(buf);
  chunks.push(buf);
  const off = cursor;
  cursor += padded;
  return off;
};
newOffsets[0] = pushChunk(atlas);
for (let i = 1; i < views.length; i++) newOffsets[i] = pushChunk(views[i].data);
const newBin = Buffer.concat(chunks);

/* 更新 JSON */
json.bufferViews[0] = { buffer: 0, byteOffset: newOffsets[0], byteLength: atlas.length };
for (let i = 1; i < views.length; i++) {
  json.bufferViews[i] = { ...json.bufferViews[i], buffer: 0, byteOffset: newOffsets[i], byteLength: views[i].byteLength };
}
json.buffers[0] = { byteLength: newBin.length };
if (!json.images || !json.images[0]) throw new Error('GLB 中没有内嵌图片可供替换');
json.images[0] = { ...json.images[0], mimeType: 'image/png', name: 'skin-recolored-atlas' };

let count = 0;
json.materials.forEach((m, i) => {
  m.pbrMetallicRoughness = m.pbrMetallicRoughness || {};
  m.pbrMetallicRoughness.baseColorTexture = { index: json.textures[i] ? i : 0, texCoord: 0 };
  m.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
  count++;
});

/* 写 GLB */
const jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = Buffer.alloc(pad4(jsonChunk.length) - jsonChunk.length, 0x20);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + pad4(jsonChunk.length) + 8 + newBin.length, 8);
const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(pad4(jsonChunk.length), 0);
jsonHeader.writeUInt32LE(0x4e4f534a, 4);
const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(newBin.length, 0);
binHeader.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(outGlb, Buffer.concat([header, jsonHeader, jsonChunk, jsonPad, binHeader, newBin]));

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';
console.log(`${inGlb} + ${atlasFile} -> ${outGlb}`);
console.log(`  贴图 ${mb(atlas.length)}（原内嵌图 ${mb(views[0].byteLength)}）  文件 ${mb(fs.statSync(outGlb).size)}（原 ${mb(b.length)}）`);
console.log(`  已把 ${count} 个材质的 baseColorTexture 指向新图集，baseColorFactor 置白`);
