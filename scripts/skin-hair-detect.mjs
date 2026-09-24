/**
 * 管状/突出几何检测 —— 从「表皮」部件里挑出穿出皮肤的毛干。
 *
 * 背景：part_4（表皮层）的网格里除了表皮片，还焊着穿过表皮层的毛干几何。
 * 它们在 UV 上和表皮同属一个部件（掩码无法区分），只能在 3D 上识别。
 *
 * 判据 A（主）突出高度：表皮顶面近似一个高度场。
 *   1) 逐 (x,z) 格取 y 的 90 分位作为该格顶面高度；
 *   2) 对高度场做中值滤波 —— 毛干很细，只污染极少数格，中值会把污染抹掉；
 *   3) 双线性插值到每个顶点，y 高于局部顶面 + MARGIN 的判为突出（毛干）。
 *   判据 B（辅）管状性：邻域法线一致性 Rbar 低 且 局部 PCA 长细比高。
 *   两者取并集，再沿三角邻接膨胀 K 环，把毛干根部衔接处一起纳入。
 *
 * 输出：
 *   scripts/_skin_src/hair_uvmask.raw     S×S uint8，1=毛发 texel（已按 DILATE 膨胀）
 *   scripts/_skin_render/hair_detect.json 统计（便于人工核对）
 *
 * 用法：
 *   node scripts/skin-hair-detect.mjs [glb] [partIdx]
 */
import fs from 'node:fs';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.glb';
const partIdx = process.argv[3] !== undefined ? Number(process.argv[3]) : 4;
const S = Number(process.env.SIZE || 4096);
const CELL = Number(process.env.CELL || 0.03);     // 高度场格边长
const MED_W = Number(process.env.MED_W || 7);      // 中值滤波窗口（格）
const MARGIN = Number(process.env.MARGIN || 0.04);      // 强判据：高于顶面多少算"确定是毛干"
const ISLAND_T = Number(process.env.ISLAND_T || 0.1);  // UV 岛被整岛纳入所需的"含种子三角形"占比
const BORDER = Number(process.env.BORDER || 0.06);      // 排除带：模型切口边缘处高度场失效
const MIN_CLUSTER = Number(process.env.MIN_CLUSTER || 20);
const MIN_H = Number(process.env.MIN_H || 0.08);        // 分量竖直跨度下限（毛干很"竖"，表面薄带不竖）
const R_NBR = Number(process.env.R_NBR || 0.012);
const TUBE_T = Number(process.env.TUBE_T || 0.62);
const ELONG_T = Number(process.env.ELONG_T || 3.0);
const DILATE = Number(process.env.DILATE || 3);    // UV 掩码膨胀像素

/* ---------- Draco 解码 ---------- */
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const mi = partIdx;
const p = json.meshes[mi].primitives[0];
const ext = p.extensions.KHR_draco_mesh_compression;
const bv = json.bufferViews[ext.bufferView];
const db = new dmod.DecoderBuffer();
db.Init(new Int8Array(buf.buffer, buf.byteOffset + (bv.byteOffset || 0), bv.byteLength), bv.byteLength);
const dec = new dmod.Decoder();
const mesh = new dmod.Mesh();
dec.DecodeBufferToMesh(db, mesh);
if (!mesh.ptr) { console.error('DECODE FAIL'); process.exit(1); }
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
const pos = get(ext.attributes.POSITION, 3);
const nrm = ext.attributes.NORMAL !== undefined ? get(ext.attributes.NORMAL, 3) : null;
const uv = get(ext.attributes.TEXCOORD_0, 2);
console.log(`${json.meshes[mi].name}: 顶点 ${n} 三角 ${nf}`);

/* ---------- 焊接顶点 ---------- */
const map = new Map();
const w = new Int32Array(n);
const accN = [], accW = [], wpos = [];
for (let i = 0; i < n; i++) {
  const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
  let id = map.get(k);
  if (id === undefined) {
    id = map.size; map.set(k, id);
    wpos.push([pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    accN.push([0, 0, 0]); accW.push(0);
  }
  w[i] = id;
  if (nrm) { accN[id][0] += nrm[i * 3]; accN[id][1] += nrm[i * 3 + 1]; accN[id][2] += nrm[i * 3 + 2]; accW[id]++; }
}
const NW = wpos.length;
const wn = new Float32Array(NW * 3);
for (let i = 0; i < NW; i++) {
  const l = Math.hypot(accN[i][0], accN[i][1], accN[i][2]) || 1;
  wn[i * 3] = accN[i][0] / l; wn[i * 3 + 1] = accN[i][1] / l; wn[i * 3 + 2] = accN[i][2] / l;
}
console.log(`焊接后顶点 ${NW}`);

/* ---------- 判据 A：局部顶面高度场 ---------- */
let mnx = Infinity, mnz = Infinity, mxx = -Infinity, mxz = -Infinity;
for (const q of wpos) { mnx = Math.min(mnx, q[0]); mxx = Math.max(mxx, q[0]); mnz = Math.min(mnz, q[2]); mxz = Math.max(mxz, q[2]); }
const GX = Math.ceil((mxx - mnx) / CELL) + 1;
const GZ = Math.ceil((mxz - mnz) / CELL) + 1;
const buckets = new Array(GX * GZ).fill(null);
for (let i = 0; i < NW; i++) {
  const gx = Math.min(GX - 1, Math.floor((wpos[i][0] - mnx) / CELL));
  const gz = Math.min(GZ - 1, Math.floor((wpos[i][2] - mnz) / CELL));
  const k = gz * GX + gx;
  if (!buckets[k]) buckets[k] = [];
  buckets[k].push(wpos[i][1]);
}
const top = new Float32Array(GX * GZ).fill(NaN);
for (let k = 0; k < buckets.length; k++) {
  const arr = buckets[k];
  if (!arr || arr.length < 4) continue;
  // 取格内 max 作为上包络：表顶面本身有起伏，用分位会漏掉高处 → 误判整片顶面
  top[k] = arr.reduce((a, c) => Math.max(a, c), -Infinity);
}
// NaN 感知中值滤波：表皮顶面本身有起伏（真皮乳头/波浪面），中值比"开运算"更贴合；
// 毛干很细（宽 0.014~0.03），只污染极少数格，中值会把它们抹掉。
const half = (MED_W - 1) >> 1;
const topF = new Float32Array(GX * GZ).fill(NaN);
for (let gz = 0; gz < GZ; gz++) for (let gx = 0; gx < GX; gx++) {
  const vals = [];
  for (let dz = -half; dz <= half; dz++) for (let dx = -half; dx <= half; dx++) {
    const x = gx + dx, z = gz + dz;
    if (x < 0 || z < 0 || x >= GX || z >= GZ) continue;
    const v = top[z * GX + x];
    if (!Number.isNaN(v)) vals.push(v);
  }
  if (vals.length >= 3) { vals.sort((a, c) => a - c); topF[gz * GX + gx] = vals[vals.length >> 1]; }
}

// 空格向外扩散填补
for (let pass = 0; pass < 60; pass++) {
  let done = true;
  for (let gz = 0; gz < GZ; gz++) for (let gx = 0; gx < GX; gx++) {
    if (!Number.isNaN(topF[gz * GX + gx])) continue;
    let s = 0, cnt = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = gx + dx, z = gz + dz;
      if (x < 0 || z < 0 || x >= GX || z >= GZ) continue;
      const v = topF[z * GX + x];
      if (!Number.isNaN(v)) { s += v; cnt++; }
    }
    if (cnt) { topF[gz * GX + gx] = s / cnt; done = false; }
  }
  if (done) break;
}
function sheetY(x, z) {
  const fx = Math.min(GX - 1.001, Math.max(0, (x - mnx) / CELL));
  const fz = Math.min(GZ - 1.001, Math.max(0, (z - mnz) / CELL));
  const x0 = Math.floor(fx), z0 = Math.floor(fz), tx = fx - x0, tz = fz - z0;
  const g = (a, c2) => {
    const v = topF[c2 * GX + a];
    return Number.isNaN(v) ? -Infinity : v;
  };
  return (g(x0, z0) * (1 - tx) + g(x0 + 1, z0) * tx) * (1 - tz)
       + (g(x0, z0 + 1) * (1 - tx) + g(x0 + 1, z0 + 1) * tx) * tz;
}
const above = new Uint8Array(NW);
let aboveCnt = 0;
for (let i = 0; i < NW; i++) {
  // 模型切口（块体侧面）边缘处，高度场会把侧壁顶点误判成"突出"，故排除 bbox 内缩一圈的带
  if (wpos[i][0] < mnx + BORDER || wpos[i][0] > mxx - BORDER ||
      wpos[i][2] < mnz + BORDER || wpos[i][2] > mxz - BORDER) continue;
  if (wpos[i][1] > sheetY(wpos[i][0], wpos[i][2]) + MARGIN) { above[i] = 1; aboveCnt++; }
}
console.log(`判据A 突出顶点：${aboveCnt} / ${NW}（${(100 * aboveCnt / NW).toFixed(2)}%）`);

/* ---------- 判据 B：管状性（法线一致性 + PCA 长细比） ---------- */
const cell = R_NBR, inv = 1 / cell;
const gridH = new Map();
for (let i = 0; i < NW; i++) {
  const k = `${Math.floor(wpos[i][0] * inv)},${Math.floor(wpos[i][1] * inv)},${Math.floor(wpos[i][2] * inv)}`;
  let a = gridH.get(k); if (!a) { a = []; gridH.set(k, a); } a.push(i);
}
const R2 = R_NBR * R_NBR;
const tube = new Uint8Array(NW);
let tubeCnt = 0;
for (let i = 0; i < NW; i++) {
  const cx = Math.floor(wpos[i][0] * inv), cy = Math.floor(wpos[i][1] * inv), cz = Math.floor(wpos[i][2] * inv);
  const nb = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const a = gridH.get(`${cx + dx},${cy + dy},${cz + dz}`);
    if (!a) continue;
    for (const j of a) {
      const ax = wpos[j][0] - wpos[i][0], ay = wpos[j][1] - wpos[i][1], az = wpos[j][2] - wpos[i][2];
      if (ax * ax + ay * ay + az * az <= R2) nb.push(j);
    }
  }
  if (nb.length < 8) continue;
  let sx = 0, sy = 0, sz = 0;
  for (const j of nb) { sx += wn[j * 3]; sy += wn[j * 3 + 1]; sz += wn[j * 3 + 2]; }
  const rbar = Math.hypot(sx, sy, sz) / nb.length;
  if (rbar >= TUBE_T) continue;
  let mx = 0, my = 0, mz = 0;
  for (const j of nb) { mx += wpos[j][0]; my += wpos[j][1]; mz += wpos[j][2]; }
  mx /= nb.length; my /= nb.length; mz /= nb.length;
  let cxx = 0, cyy = 0, czz = 0, cxy = 0, cxz = 0, cyz = 0;
  for (const j of nb) {
    const ax = wpos[j][0] - mx, ay = wpos[j][1] - my, az = wpos[j][2] - mz;
    cxx += ax * ax; cyy += ay * ay; czz += az * az; cxy += ax * ay; cxz += ax * az; cyz += ay * az;
  }
  let v = [1, 0.3, 0.7];
  for (let it = 0; it < 24; it++) {
    const nx = cxx * v[0] + cxy * v[1] + cxz * v[2];
    const ny = cxy * v[0] + cyy * v[1] + cyz * v[2];
    const nz = cxz * v[0] + cyz * v[1] + czz * v[2];
    const l = Math.hypot(nx, ny, nz) || 1;
    v = [nx / l, ny / l, nz / l];
  }
  const l1 = v[0] * (cxx * v[0] + cxy * v[1] + cxz * v[2]) + v[1] * (cxy * v[0] + cyy * v[1] + cyz * v[2]) + v[2] * (cxz * v[0] + cyz * v[1] + czz * v[2]);
  const t = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let u = [v[1] * t[2] - v[2] * t[1], v[2] * t[0] - v[0] * t[2], v[0] * t[1] - v[1] * t[0]];
  const ul = Math.hypot(...u) || 1; u = u.map((x) => x / ul);
  const wv = [v[1] * u[2] - v[2] * u[1], v[2] * u[0] - v[0] * u[2], v[0] * u[1] - v[1] * u[0]];
  const a11 = u[0] * (cxx * u[0] + cxy * u[1] + cxz * u[2]) + u[1] * (cxy * u[0] + cyy * u[1] + cyz * u[2]) + u[2] * (cxz * u[0] + cyz * u[1] + czz * u[2]);
  const a22 = wv[0] * (cxx * wv[0] + cxy * wv[1] + cxz * wv[2]) + wv[1] * (cxy * wv[0] + cyy * wv[1] + cyz * wv[2]) + wv[2] * (cxz * wv[0] + cyz * wv[1] + czz * wv[2]);
  const a12 = u[0] * (cxx * wv[0] + cxy * wv[1] + cxz * wv[2]) + u[1] * (cxy * wv[0] + cyy * wv[1] + cyz * wv[2]) + u[2] * (cxz * wv[0] + cyz * wv[1] + czz * wv[2]);
  let q = [1, 0.4];
  for (let it = 0; it < 20; it++) {
    const nx = a11 * q[0] + a12 * q[1], ny = a12 * q[0] + a22 * q[1];
    const l = Math.hypot(nx, ny) || 1;
    q = [nx / l, ny / l];
  }
  const l2 = q[0] * (a11 * q[0] + a12 * q[1]) + q[1] * (a12 * q[0] + a22 * q[1]);
  const el = l2 > 1e-12 ? Math.sqrt(l1 / l2) : 99;
  if (el > ELONG_T) { tube[i] = 1; tubeCnt++; }
}
console.log(`判据B 管状顶点：${tubeCnt} / ${NW}（${(100 * tubeCnt / NW).toFixed(2)}%）`);

let seed = new Uint8Array(NW);
for (let i = 0; i < NW; i++) seed[i] = (above[i] || tube[i]) ? 1 : 0;

/* ---------- UV 岛级补全 ----------
 * 毛干在 3D 上与表皮焊在一起，但在 UV 上是独立的岛（有 UV 接缝）。
 * 只按"离表面够高"判定会在毛干外扩的根部断掉；改为：
 *   只要一个 UV 岛上有足够的毛干种子，就把整座岛都算作毛发 →
 *   既补齐根部，又完全不会波及表皮（岛之间不共享 texel）。
 */
const uvKey = new Map();
const wu = new Int32Array(n);   // 顶点 → UV 焊接 id
for (let i = 0; i < n; i++) {
  const k = `${Math.round(uv[i * 2] * 1e5)},${Math.round(uv[i * 2 + 1] * 1e5)}`;
  let id = uvKey.get(k);
  if (id === undefined) { id = uvKey.size; uvKey.set(k, id); }
  wu[i] = id;
}
const dsuU = new Int32Array(uvKey.size).map((_, i) => i);
const findU = (x) => { while (dsuU[x] !== x) { dsuU[x] = dsuU[dsuU[x]]; x = dsuU[x]; } return x; };
const uniU = (a, c) => { a = findU(a); c = findU(c); if (a !== c) dsuU[c] = a; };
for (let f = 0; f < nf; f++) {
  uniU(wu[idx[f * 3]], wu[idx[f * 3 + 1]]);
  uniU(wu[idx[f * 3]], wu[idx[f * 3 + 2]]);
}
const isl = new Map();   // UV 岛 → {tris, seedTris, mn, mx}
for (let f = 0; f < nf; f++) {
  const r = findU(wu[idx[f * 3]]);
  let it2 = isl.get(r);
  if (!it2) { it2 = { tris: 0, seedTris: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; isl.set(r, it2); }
  it2.tris++;
  let sd = false;
  for (let t = 0; t < 3; t++) {
    const vi = idx[f * 3 + t];
    if (seed[w[vi]]) sd = true;
    for (let k = 0; k < 3; k++) {
      it2.mn[k] = Math.min(it2.mn[k], pos[vi * 3 + k]);
      it2.mx[k] = Math.max(it2.mx[k], pos[vi * 3 + k]);
    }
  }
  if (sd) it2.seedTris++;
}
const islands = [...isl.values()];
const keepIsland = new Set();
for (const [r, it2] of isl) {
  const h = it2.mx[1] - it2.mn[1];
  const frac = it2.seedTris / Math.max(1, it2.tris);
  if (it2.seedTris > 0 && frac >= ISLAND_T && h >= MIN_H) keepIsland.add(r);
}
console.log(`UV 岛：共 ${islands.length} 座，含种子的 ${islands.filter((c) => c.seedTris > 0).length} 座，` +
  `按 种子占比≥${ISLAND_T} 且 竖直跨度≥${MIN_H} 保留 ${keepIsland.size} 座`);

let flag = new Uint8Array(NW);
for (let f = 0; f < nf; f++) {
  if (!keepIsland.has(findU(wu[idx[f * 3]]))) continue;
  for (let t = 0; t < 3; t++) flag[w[idx[f * 3 + t]]] = 1;
}
const flagCnt = flag.reduce((s, v) => s + v, 0);
console.log(`岛级补全后顶点：${flagCnt} / ${NW}（${(100 * flagCnt / NW).toFixed(2)}%）`);

/* ---------- 连通分量统计（便于核对：应该 ≈ 毛发根数） ---------- */
const dsu = new Int32Array(NW).map((_, i) => i);
const find = (x) => { while (dsu[x] !== x) { dsu[x] = dsu[dsu[x]]; x = dsu[x]; } return x; };
const uni = (a, c) => { a = find(a); c = find(c); if (a !== c) dsu[c] = a; };
for (let f = 0; f < nf; f++) {
  if (!flag[w[idx[f * 3]]] || !flag[w[idx[f * 3 + 1]]] || !flag[w[idx[f * 3 + 2]]]) continue;
  uni(w[idx[f * 3]], w[idx[f * 3 + 1]]); uni(w[idx[f * 3]], w[idx[f * 3 + 2]]);
}
const cl = new Map();
for (let i = 0; i < NW; i++) {
  if (!flag[i]) continue;
  const r = find(i);
  let c = cl.get(r);
  if (!c) { c = { verts: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; cl.set(r, c); }
  c.verts++;
  for (let k = 0; k < 3; k++) { c.mn[k] = Math.min(c.mn[k], wpos[i][k]); c.mx[k] = Math.max(c.mx[k], wpos[i][k]); }
}
const clusters = [...cl.values()].map((c) => {
  const size = [c.mx[0] - c.mn[0], c.mx[1] - c.mn[1], c.mx[2] - c.mn[2]].map((x) => +x.toFixed(3));
  const sorted = [...size].sort((a, c2) => c2 - a);
  return { verts: c.verts, size, elong: +(sorted[0] / Math.max(1e-6, sorted[1])).toFixed(1), mn: c.mn.map((x) => +x.toFixed(3)) };
}).sort((a, c) => c.verts - a.verts);
console.log(`连通分量：${clusters.length} 个`);
for (const [i, c] of clusters.slice(0, 15).entries())
  console.log(`  [${i}] 顶点=${c.verts} 尺寸=${c.size.join('×')} 长细比=${c.elong}`);

// 丢掉过小的碎块（噪声）与不"竖直"的表面薄带，保留真正的毛干
const keepRoot = new Set();
for (const [root, c] of cl) {
  const h = c.mx[1] - c.mn[1];
  if (c.verts >= MIN_CLUSTER && h >= MIN_H) keepRoot.add(root);
}
let dropped = 0;
for (let i = 0; i < NW; i++) {
  if (flag[i] && !keepRoot.has(find(i))) { flag[i] = 0; dropped++; }
}
console.log(`按 顶点≥${MIN_CLUSTER} 且 竖直跨度≥${MIN_H} 过滤：丢弃 ${dropped} 个顶点，保留 ${keepRoot.size} 个分量`);

/* ---------- 栅格化 → UV 掩码 ---------- */
const mask = new Uint8Array(S * S);
let triHit = 0;
for (let f = 0; f < nf; f++) {
  const a = idx[f * 3], c = idx[f * 3 + 1], e = idx[f * 3 + 2];
  if (!(flag[w[a]] || flag[w[c]] || flag[w[e]])) continue;
  triHit++;
  const xs = [uv[a * 2] * S, uv[c * 2] * S, uv[e * 2] * S];
  const ys = [uv[a * 2 + 1] * S, uv[c * 2 + 1] * S, uv[e * 2 + 1] * S];
  const mnx = Math.max(0, Math.floor(Math.min(...xs)));
  const mxx = Math.min(S - 1, Math.ceil(Math.max(...xs)));
  const mny = Math.max(0, Math.floor(Math.min(...ys)));
  const mxy = Math.min(S - 1, Math.ceil(Math.max(...ys)));
  if ((mxx - mnx) * (mxy - mny) > 4e6) continue;
  const area = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
  if (Math.abs(area) < 1e-9) continue;
  const inv = 1 / area;
  for (let y = mny; y <= mxy; y++) for (let x = mnx; x <= mxx; x++) {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((xs[1] - px) * (ys[2] - py) - (ys[1] - py) * (xs[2] - px)) * inv;
    const w1 = ((xs[2] - px) * (ys[0] - py) - (ys[2] - py) * (xs[0] - px)) * inv;
    const w2 = 1 - w0 - w1;
    if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
    mask[y * S + x] = 1;
  }
}
// 膨胀
let cur = mask;
for (let it = 0; it < DILATE; it++) {
  const nxt = new Uint8Array(cur);
  for (let y = 0; y < S; y++) {
    const row = y * S;
    for (let x = 0; x < S; x++) {
      const k = row + x;
      if (cur[k]) continue;
      if ((x > 0 && cur[k - 1]) || (x < S - 1 && cur[k + 1]) ||
          (y > 0 && cur[k - S]) || (y < S - 1 && cur[k + S])) nxt[k] = 1;
    }
  }
  cur = nxt;
}
const total = cur.reduce((s, v) => s + v, 0);
console.log(`UV 掩码：${total} texel（${(100 * total / (S * S)).toFixed(3)}%），命中三角形 ${triHit}`);

fs.writeFileSync('scripts/_skin_src/hair_uvmask.raw', Buffer.from(cur));
// 调试用：导出焊接顶点与标记点坐标，便于投影成图检查误报
{
  const all = new Float32Array(NW * 3);
  for (let i = 0; i < NW; i++) { all[i * 3] = wpos[i][0]; all[i * 3 + 1] = wpos[i][1]; all[i * 3 + 2] = wpos[i][2]; }
  fs.writeFileSync('scripts/_skin_src/hair_dbg_all.f32', Buffer.from(all.buffer));
  const fl = [];
  for (let i = 0; i < NW; i++) if (flag[i]) fl.push(wpos[i][0], wpos[i][1], wpos[i][2]);
  fs.writeFileSync('scripts/_skin_src/hair_dbg_flag.f32', Buffer.from(new Float32Array(fl).buffer));
}
fs.writeFileSync('scripts/_skin_render/hair_detect.json', JSON.stringify({
  part: mi, cell: CELL, medW: MED_W, margin: MARGIN, islandT: ISLAND_T, border: BORDER,
  rNbr: R_NBR, tubeT: TUBE_T, elongT: ELONG_T, dilate: DILATE,
  aboveCnt, tubeCnt, flagCnt, islandTotal: islands.length, islandKept: keepIsland.size,
  total: NW, maskTexels: total, triHit, clusters,
}, null, 1));
console.log('写出 scripts/_skin_src/hair_uvmask.raw 与 scripts/_skin_render/hair_detect.json');
