import fs from 'node:fs';
import zlib from 'node:zlib';
import draco3d from 'draco3d';

/* ---------- PNG 编码 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

/* ---------- 读取 GLB ---------- */
const b = fs.readFileSync(process.argv[2] || 'public/models/organ-skin.glb');
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dm = await draco3d.createDecoderModule({});

const parts = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dm.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dm.Decoder(); const mesh = new dm.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  const n = mesh.num_points();
  const attr = dec.GetAttributeByUniqueId(mesh, ext.attributes.POSITION);
  const arr = new dm.DracoFloat32Array();
  dec.GetAttributeFloatForAllPoints(mesh, attr, arr);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < pos.length; i++) pos[i] = arr.GetValue(i);
  const col = json.materials[p.material].pbrMetallicRoughness.baseColorFactor;
  parts.push({ mi, name: json.meshes[mi].name, pos, n, color: col.map(v => Math.round(v * 255)) });
}

const gmn = [Infinity, Infinity, Infinity], gmx = [-Infinity, -Infinity, -Infinity];
for (const pt of parts) for (let i = 0; i < pt.pos.length; i += 3)
  for (let k = 0; k < 3; k++) { if (pt.pos[i + k] < gmn[k]) gmn[k] = pt.pos[i + k]; if (pt.pos[i + k] > gmx[k]) gmx[k] = pt.pos[i + k]; }

/* ---------- 点云正交渲染（z-buffer） ---------- */
const ID_COLORS = [[232,200,79],[226,190,142],[234,217,168],[90,58,36],[230,188,143],[107,73,46],[240,226,192]];
const DISTINCT = [[230,80,60],[60,140,230],[80,200,90],[250,220,40],[190,90,220],[40,210,210],[250,140,40]];
const LABELS = ['P0 黄 #e8c84f','P1 粉褐 #e2be8e','P2 米黄 #ead9a8','P3 深棕 #5a3a24','P4 浅褐 #e6bc8f','P5 棕 #6b492e','P6 米白 #f0e2c0'];

function render(W, H, viewAxis, upAxis, rightSign, palette, bg = [255, 255, 255]) {
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) { rgb[i * 3] = bg[0]; rgb[i * 3 + 1] = bg[1]; rgb[i * 3 + 2] = bg[2]; }
  const depth = new Float32Array(W * H).fill(-Infinity);

  const a0 = gmn[viewAxis], a1 = gmx[viewAxis], b0 = gmn[upAxis], b1 = gmx[upAxis];
  const pad = 0.04;
  const spanA = (a1 - a0) * (1 + pad * 2), spanB = (b1 - b0) * (1 + pad * 2);
  const scale = Math.min(W / spanA, H / spanB);

  for (const pt of parts) {
    const col = palette[pt.mi];
    for (let i = 0; i < pt.pos.length; i += 3) {
      const u = ((pt.pos[i + viewAxis] - (a0 + a1) / 2) * rightSign) * scale + W / 2;
      const v = H / 2 - (pt.pos[i + upAxis] - (b0 + b1) / 2) * scale;
      const d = pt.pos[i + 3 - viewAxis - upAxis]; // 剩余轴作为深度
      const px = Math.round(u), py = Math.round(v);
      // 3x3 splat 填充空隙
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const x = px + ox, y = py + oy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const k = y * W + x;
        if (d > depth[k]) { depth[k] = d; rgb[k * 3] = col[0]; rgb[k * 3 + 1] = col[1]; rgb[k * 3 + 2] = col[2]; }
      }
    }
  }
  return rgb;
}

const W = 760, H = 560;
const outDir = process.argv[3] || 'scripts/_skin_render';
fs.mkdirSync(outDir, { recursive: true });

const views = [
  { name: 'front',  args: [2, 1, -1], desc: 'front (-Z)' },
  { name: 'side',   args: [0, 1, 1],  desc: 'side (+X)' },
  { name: 'iso',    args: [2, 1, -1], desc: 'iso-ish' },
];
writePNG(`${outDir}/current_front.png`, W, H, render(W, H, 2, 1, -1, ID_COLORS));
writePNG(`${outDir}/current_side.png`, W, H, render(W, H, 0, 1, 1, ID_COLORS));
writePNG(`${outDir}/ids_front.png`, W, H, render(W, H, 2, 1, -1, DISTINCT));
writePNG(`${outDir}/ids_side.png`, W, H, render(W, H, 0, 1, 1, DISTINCT));

// 逐部件隔离渲染（front / side）
for (let i = 0; i < parts.length; i++) {
  const pal = DISTINCT.map(() => [222, 222, 222]);
  pal[i] = DISTINCT[i];
  const saved = parts.map(p => p.pos);
  parts.forEach((p, k) => { p.pos = k === i ? saved[k] : new Float32Array(0); });
  writePNG(`${outDir}/solo_${i}_front.png`, W, H, render(W, H, 2, 1, -1, pal));
  writePNG(`${outDir}/solo_${i}_side.png`, W, H, render(W, H, 0, 1, 1, pal));
  parts.forEach((p, k) => { p.pos = saved[k]; });
}
console.log('wrote', outDir);
LABELS.forEach((l, i) => console.log(' ', l, '-> flat color rgb(' + DISTINCT[i].join(',') + ')'));
