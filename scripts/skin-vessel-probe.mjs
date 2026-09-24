/**
 * 皮肤模型血管探针
 * 用贴图（默认 interactive-lod 的 4096 basecolor）对主模型逐三角形采样，
 * 统计各部件落在「红色动脉 / 蓝色静脉 / 深色毛发 / 其他」的比例，
 * 并渲染一张分类图，用来判断贴图 UV 是否与主模型对齐、血管是否真实存在。
 *
 * 用法：
 *   node scripts/skin-vessel-probe.mjs [glb] [outDir]
 *   ATLAS_FILE=scripts/_atlas4096.raw ATLAS_SIZE=4096 node scripts/skin-vessel-probe.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.glb';
const outDir = process.argv[3] || 'scripts/_skin_render';
fs.mkdirSync(outDir, { recursive: true });

const ATLAS_FILE = process.env.ATLAS_FILE || 'scripts/_atlas4096.raw';
const ATLAS_SIZE = Number(process.env.ATLAS_SIZE || 4096);
// PART=6 → 只保留 part_6 参与统计与渲染（用于定位"某个部件颜色不对"）
const ONLY_PART = process.env.PART ? Number(process.env.PART) : null;
const atlas = fs.readFileSync(ATLAS_FILE);

/* ---------- 读 GLB + Draco 解码 ---------- */
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const parts = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  const p = json.meshes[mi].primitives[0];
  const ext = p.extensions.KHR_draco_mesh_compression;
  const bv = json.bufferViews[ext.bufferView];
  const db = new dmod.DecoderBuffer();
  db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
  const dec = new dmod.Decoder();
  const mesh = new dmod.Mesh();
  dec.DecodeBufferToMesh(db, mesh);
  if (!mesh.ptr) { console.error('mesh', mi, 'DECODE FAIL'); continue; }
  const n = mesh.num_points(), nf = mesh.num_faces();
  const get = (uid, c) => {
    const a = dec.GetAttributeByUniqueId(mesh, uid);
    const arr = new dmod.DracoFloat32Array();
    dec.GetAttributeFloatForAllPoints(mesh, a, arr);
    const o = new Float32Array(n * c);
    for (let i = 0; i < o.length; i++) o[i] = arr.GetValue(i);
    return o;
  };
  const farr = new dmod.DracoInt32Array();
  const idx = new Uint32Array(nf * 3);
  for (let f = 0; f < nf; f++) {
    dec.GetFaceFromMesh(mesh, f, farr);
    idx[f * 3] = farr.GetValue(0);
    idx[f * 3 + 1] = farr.GetValue(1);
    idx[f * 3 + 2] = farr.GetValue(2);
  }
  parts.push({
    mi,
    name: json.meshes[mi].name,
    matName: json.materials[p.material].name,
    pos: get(ext.attributes.POSITION, 3),
    nrm: ext.attributes.NORMAL !== undefined ? get(ext.attributes.NORMAL, 3) : null,
    uv: get(ext.attributes.TEXCOORD_0, 2),
    idx,
    n, nf,
  });
}

const allParts = parts.slice();   // 未过滤的全量部件（KEEP_BBOX 时用于统一取景）
if (ONLY_PART !== null) {
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].mi !== ONLY_PART) parts.splice(i, 1);
  if (!parts.length) { console.error(`没有 mi=${ONLY_PART} 的部件`); process.exit(1); }
}

/* ---------- 贴图采样与分类 ---------- */
const A = ATLAS_SIZE;
function sampleAtlas(u, v) {
  // glTF：UV (0,0) 对应贴图左上角，因此行 = v * S（不翻转）
  let x = Math.round(u * (A - 1));
  let y = Math.round(v * (A - 1));
  x = Math.min(A - 1, Math.max(0, x));
  y = Math.min(A - 1, Math.max(0, y));
  const o = (y * A + x) * 3;
  return [atlas[o], atlas[o + 1], atlas[o + 2]];
}

// 0=其他 1=红(动脉) 2=蓝(静脉) 3=深色(毛发) 4=黄(脂肪)
function classify(r, g, blue) {
  const mx = Math.max(r, g, blue), mn = Math.min(r, g, blue);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  if (r + g + blue < 120) return 3;                     // 暗
  if (r > 95 && r > g * 1.45 && r > blue * 1.5 && sat > 0.3) return 1;   // 红
  if (blue > 80 && blue > r * 1.18 && blue > g * 1.05 && sat > 0.12) return 2; // 蓝
  if (r > 150 && g > 110 && blue < g * 0.85 && sat > 0.25) return 4;  // 黄
  return 0;
}

const CLASS_NAME = ['其他', '红(动脉)', '蓝(静脉)', '深色', '黄(脂肪)'];
const CLASS_RGB = [[200, 200, 200], [220, 40, 40], [40, 70, 220], [60, 45, 35], [235, 200, 90]];
// 逐部件 ID 配色（mode='part'，用于确认某块几何属于哪个部件）
const PART_RGB = [[235, 200, 90], [200, 90, 90], [60, 190, 190], [30, 30, 30], [245, 180, 130], [150, 90, 200], [40, 110, 240]];
const PART_NAME = ['part_0 脂肪', 'part_1 真皮', 'part_2 腺体', 'part_3 毛发', 'part_4 表皮', 'part_5 毛囊', 'part_6 毛干'];

console.log(`=== 贴图: ${ATLAS_FILE} (${A}x${A}) 模型: ${path.basename(file)} ===`);
const stats = [];
for (const part of parts) {
  const cnt = new Array(5).fill(0);
  const sum = [0, 0, 0];
  let black = 0, tris = 0;
  const triClass = new Uint8Array(part.nf);
  for (let f = 0; f < part.nf; f++) {
    const a = part.idx[f * 3], c = part.idx[f * 3 + 1], e = part.idx[f * 3 + 2];
    // 三角形 UV 面积过大说明跨岛，跳过
    const du1 = part.uv[c * 2] - part.uv[a * 2], dv1 = part.uv[c * 2 + 1] - part.uv[a * 2 + 1];
    const du2 = part.uv[e * 2] - part.uv[a * 2], dv2 = part.uv[e * 2 + 1] - part.uv[a * 2 + 1];
    if (Math.abs(du1 * dv2 - dv1 * du2) > 0.01) { triClass[f] = 0; continue; }
    // 顶点平均采样
    const c1 = sampleAtlas(part.uv[a * 2], part.uv[a * 2 + 1]);
    const c2 = sampleAtlas(part.uv[c * 2], part.uv[c * 2 + 1]);
    const c3 = sampleAtlas(part.uv[e * 2], part.uv[e * 2 + 1]);
    const r = (c1[0] + c2[0] + c3[0]) / 3, g = (c1[1] + c2[1] + c3[1]) / 3, bl = (c1[2] + c2[2] + c3[2]) / 3;
    const k = classify(r, g, bl);
    triClass[f] = k;
    cnt[k]++;
    tris++;
    if (r + g + bl < 120) black++;
    sum[0] += r; sum[1] += g; sum[2] += bl;
  }
  const pct = cnt.map(v => (v / Math.max(1, tris) * 100));
  const avg = tris ? sum.map(v => Math.round(v / tris)) : [0, 0, 0];
  stats.push({ mi: part.mi, name: part.name, tris, pct, avg, blackPct: black / Math.max(1, tris) * 100 });
  console.log(
    `[${part.mi}] ${part.name.padEnd(14)} 三角=${String(tris).padStart(7)}  ` +
    `均值=rgb(${avg.join(',')})  暗部=${(black / Math.max(1, tris) * 100).toFixed(1)}%  ` +
    `红=${pct[1].toFixed(1)}%  蓝=${pct[2].toFixed(1)}%  深=${pct[3].toFixed(1)}%  黄=${pct[4].toFixed(1)}%`
  );

  // 顶点级分类（供后续写 COLOR_0 参考）
  const vClass = new Uint8Array(part.n);
  const vCount = new Uint32Array(part.n);
  for (let f = 0; f < part.nf; f++) {
    const k = triClass[f];
    for (let t = 0; t < 3; t++) { const vi = part.idx[f * 3 + t]; vClass[vi] += k; vCount[vi]++; }
  }
  part.vClass = vClass;
  part.triClass = triClass;
  part.triClassRGB = CLASS_RGB;
  part.vertexClassColor = vClass.map((s, i) => (vCount[i] ? Math.round(s / vCount[i]) : 0));
}

/* ---------- 渲染分类图 ---------- */
function norm(v) { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }
function cross(a, c) { return [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]]; }

function render(W, H, viewDir, mode) {
  const d = norm(viewDir);
  const r0 = norm(cross([0, 1, 0], d));
  const u0 = norm(cross(d, r0));
  // 全局 bbox（KEEP_BBOX=1 时用全量部件取景，便于跨部件同视角对比）
  const bboxParts = process.env.KEEP_BBOX ? allParts : parts;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of bboxParts) for (let i = 0; i < p.pos.length; i += 3)
    for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.pos[i + k]); mx[k] = Math.max(mx[k], p.pos[i + k]); }
  const cen = mx.map((v, k) => (v + mn[k]) / 2);
  const rad = Math.max(...mx.map((v, k) => v - mn[k])) * 0.5;
  const scale = Math.min(W, H) * 0.43 / rad;   // rad 是半幅，故系数取 0.86/2

  const img = Buffer.alloc(W * H * 3, 255);
  const depth = new Float32Array(W * H).fill(-Infinity);
  const L = norm([-0.5, 0.75, 0.6]);

  for (const part of parts) {
    const P = part.pos, N = part.nrm;
    for (let f = 0; f < part.nf; f++) {
      const ia = part.idx[f * 3], ib = part.idx[f * 3 + 1], ic = part.idx[f * 3 + 2];
      const scr = [ia, ib, ic].map(i => {
        const x = P[i * 3] - cen[0], y = P[i * 3 + 1] - cen[1], z = P[i * 3 + 2] - cen[2];
        const sx = W / 2 + (x * r0[0] + y * r0[1] + z * r0[2]) * scale;
        const sy = H / 2 - (x * u0[0] + y * u0[1] + z * u0[2]) * scale;
        const sz = x * d[0] + y * d[1] + z * d[2];
        return [sx, sy, sz];
      });
      // 背面剔除
      const area = (scr[1][0] - scr[0][0]) * (scr[2][1] - scr[0][1]) - (scr[1][1] - scr[0][1]) * (scr[2][0] - scr[0][0]);
      if (area <= 0) continue;
      let col;
      if (mode === 'class') col = CLASS_RGB[part.triClass[f]];
      else if (mode === 'part') col = PART_RGB[part.mi];
      else if (mode === 'solid') col = [190, 190, 190];
      else col = [200, 200, 200];
      // 光照
      let sh = 0.75;
      if (N) {
        const nx = (N[ia * 3] + N[ib * 3] + N[ic * 3]) / 3;
        const ny = (N[ia * 3 + 1] + N[ib * 3 + 1] + N[ic * 3 + 1]) / 3;
        const nz = (N[ia * 3 + 2] + N[ib * 3 + 2] + N[ic * 3 + 2]) / 3;
        const nl = Math.hypot(nx, ny, nz) || 1;
        sh = 0.45 + 0.8 * Math.abs((nx * L[0] + ny * L[1] + nz * L[2]) / nl);
      }
      const UV = part.uv;
      const ua = UV[ia * 2], va = UV[ia * 2 + 1];
      const ub = UV[ib * 2], vb = UV[ib * 2 + 1];
      const uc = UV[ic * 2], vc = UV[ic * 2 + 1];
      const minX = Math.max(0, Math.floor(Math.min(scr[0][0], scr[1][0], scr[2][0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(scr[0][0], scr[1][0], scr[2][0])));
      const minY = Math.max(0, Math.floor(Math.min(scr[0][1], scr[1][1], scr[2][1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(scr[0][1], scr[1][1], scr[2][1])));
      if (maxX < minX || maxY < minY || (maxX - minX) * (maxY - minY) > 4e6) continue;
      const inv = 1 / area;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((scr[1][0] - px) * (scr[2][1] - py) - (scr[1][1] - py) * (scr[2][0] - px)) * inv;
        const w1 = ((scr[2][0] - px) * (scr[0][1] - py) - (scr[2][1] - py) * (scr[0][0] - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
        const z = w0 * scr[0][2] + w1 * scr[1][2] + w2 * scr[2][2];
        const k = y * W + x;
        if (z <= depth[k]) continue;
        depth[k] = z;
        const o = k * 3;
        if (mode === 'tex') {
          const u = w0 * ua + w1 * ub + w2 * uc;
          const v = w0 * va + w1 * vb + w2 * vc;
          const t = sampleAtlas(u, v);
          img[o] = Math.min(255, t[0] * sh);
          img[o + 1] = Math.min(255, t[1] * sh);
          img[o + 2] = Math.min(255, t[2] * sh);
        } else {
          img[o] = Math.min(255, col[0] * sh);
          img[o + 1] = Math.min(255, col[1] * sh);
          img[o + 2] = Math.min(255, col[2] * sh);
        }
      }
    }
  }
  return img;
}

/* PNG 写出（无依赖） */
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePNG(file, W, H, rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

const W = 760, H = 620;
const tag = ONLY_PART === null ? '' : `_p${ONLY_PART}`;
writePNG(`${outDir}/vessel_class_iso${tag}.png`, W, H, render(W, H, [1, 0.85, 1], 'class'));
writePNG(`${outDir}/vessel_part_iso${tag}.png`, W, H, render(W, H, [1, 0.85, 1], 'part'));
writePNG(`${outDir}/vessel_part_isoL${tag}.png`, W, H, render(W, H, [-1, 0.85, 1], 'part'));
writePNG(`${outDir}/vessel_class_isoL${tag}.png`, W, H, render(W, H, [-1, 0.85, 1], 'class'));
writePNG(`${outDir}/vessel_class_top${tag}.png`, W, H, render(W, H, [0, 1, 0.001], 'class'));
writePNG(`${outDir}/vessel_tex_iso${tag}.png`, W, H, render(W, H, [1, 0.85, 1], 'tex'));
writePNG(`${outDir}/vessel_tex_isoL${tag}.png`, W, H, render(W, H, [-1, 0.85, 1], 'tex'));
writePNG(`${outDir}/vessel_tex_top${tag}.png`, W, H, render(W, H, [0, 1, 0.001], 'tex'));
console.log(`\n已写出分类图到 ${outDir}/vessel_class_*.png`);
console.log('图例: 灰=其他  红=动脉  蓝=静脉  深=毛发/暗部  黄=脂肪');
fs.writeFileSync(`${outDir}/_vessel_stats.json`, JSON.stringify(stats, null, 1));
