/**
 * 部件连通分量分析
 * 用 Draco 解码 GLB，对指定部件做「焊接顶点 → 三角形连通分量」分析，
 * 报告每个分量的顶点数/包围盒/长细比/贴图采样均色，用来找出某个部件里
 * 「混进来的异质几何」（例：表皮 part_4 里混着穿出皮肤的毛干）。
 *
 * 用法：
 *   node scripts/skin-part-components.mjs [glb] [partIdx] [--top N]
 *   ATLAS_FILE=... ATLAS_SIZE=4096 node scripts/skin-part-components.mjs public/models/organ-skin.glb 4 --top 20
 */
import fs from 'node:fs';
import draco3d from 'draco3d';

const file = process.argv[2] || 'public/models/organ-skin.glb';
const onlyPart = process.argv[3] !== undefined ? Number(process.argv[3]) : null;
const topN = (() => {
  const i = process.argv.indexOf('--top');
  return i >= 0 ? Number(process.argv[i + 1]) : 15;
})();

const ATLAS_FILE = process.env.ATLAS_FILE || 'scripts/_skin_src/atlas_painted_4096.raw';
const ATLAS_SIZE = Number(process.env.ATLAS_SIZE || 4096);
const atlas = fs.readFileSync(ATLAS_FILE);
const A = ATLAS_SIZE;

function sampleAtlas(u, v) {
  let x = Math.round(u * (A - 1));
  let y = Math.round(v * (A - 1));
  x = Math.min(A - 1, Math.max(0, x));
  y = Math.min(A - 1, Math.max(0, y));
  const o = (y * A + x) * 3;
  return [atlas[o], atlas[o + 1], atlas[o + 2]];
}

/* ---------- 读 GLB + Draco 解码 ---------- */
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen).replace(/\0+$/g, ''));
const binStart = 20 + jsonLen;
const buf = b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart));
const dmod = await draco3d.createDecoderModule({});

const parts = [];
for (let mi = 0; mi < json.meshes.length; mi++) {
  if (onlyPart !== null && mi !== onlyPart) continue;
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
    pos: get(ext.attributes.POSITION, 3),
    uv: get(ext.attributes.TEXCOORD_0, 2),
    idx, n, nf,
  });
}

/* ---------- 焊接顶点（按 1e-4 量化位置） ---------- */
function weld(pos, n) {
  const map = new Map();
  const w = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
    let id = map.get(k);
    if (id === undefined) { id = map.size; map.set(k, id); }
    w[i] = id;
  }
  return { w, count: map.size };
}

class DSU {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
  union(a, c) { a = this.find(a); c = this.find(c); if (a !== c) this.p[c] = a; }
}

for (const part of parts) {
  const { w, count } = weld(part.pos, part.n);
  const dsu = new DSU(count);
  for (let f = 0; f < part.nf; f++) {
    const a = w[part.idx[f * 3]], c = w[part.idx[f * 3 + 1]], e = w[part.idx[f * 3 + 2]];
    dsu.union(a, c); dsu.union(a, e);
  }
  // 收集分量
  const comps = new Map();   // root -> {verts:Set, tris:[], mn, mx}
  for (let i = 0; i < part.n; i++) {
    const r = dsu.find(w[i]);
    let c = comps.get(r);
    if (!c) { c = { vids: new Set(), tris: 0, mn: [1e9, 1e9, 1e9], mx: [-1e9, -1e9, -1e9] }; comps.set(r, c); }
    if (!c.vids.has(i)) {
      c.vids.add(i);
      for (let k = 0; k < 3; k++) {
        c.mn[k] = Math.min(c.mn[k], part.pos[i * 3 + k]);
        c.mx[k] = Math.max(c.mx[k], part.pos[i * 3 + k]);
      }
    }
  }
  for (let f = 0; f < part.nf; f++) {
    const r = dsu.find(w[part.idx[f * 3]]);
    comps.get(r).tris++;
  }
  const list = [...comps.values()].map((c) => {
    const size = [c.mx[0] - c.mn[0], c.mx[1] - c.mn[1], c.mx[2] - c.mn[2]];
    const sorted = [...size].sort((x, y) => y - x);
    // 长细比：最长边 / 中间边
    const elong = sorted[1] > 1e-6 ? sorted[0] / sorted[1] : Infinity;
    // 采样贴图
    let r = 0, g = 0, bl = 0, cnt = 0, dark = 0;
    for (const vi of c.vids) {
      const t = sampleAtlas(part.uv[vi * 2], part.uv[vi * 2 + 1]);
      r += t[0]; g += t[1]; bl += t[2]; cnt++;
      if (t[0] + t[1] + t[2] < 120) dark++;
    }
    return {
      verts: c.vids.size, tris: c.tris,
      mn: c.mn.map((x) => +x.toFixed(3)), mx: c.mx.map((x) => +x.toFixed(3)),
      size: size.map((x) => +x.toFixed(3)), elong: +elong.toFixed(1),
      avg: [Math.round(r / cnt), Math.round(g / cnt), Math.round(bl / cnt)],
      darkPct: +(dark / cnt * 100).toFixed(1),
      vids: c.vids,
    };
  }).sort((a, c) => c.tris - a.tris);

  console.log(`\n=== ${part.name}（mi=${part.mi}）焊接顶点 ${count}，连通分量 ${list.length} 个 ===`);
  for (const [i, c] of list.slice(0, topN).entries()) {
    console.log(
      `[${String(i).padStart(2)}] 三角=${String(c.tris).padStart(6)} 顶点=${String(c.verts).padStart(6)} ` +
      `尺寸=${c.size.join('×')} 长细比=${c.elong} 均色=rgb(${c.avg.join(',')}) 暗=${c.darkPct}%`
    );
  }
  part.components = list;
}

// 导出大分量列表（供渲染脚本按分量着色）
const dump = parts.map((p) => ({
  mi: p.mi, name: p.name,
  components: p.components.map((c) => ({ tris: c.tris, verts: c.verts, size: c.size, avg: c.avg })),
}));
fs.writeFileSync('scripts/_skin_render/part_components.json', JSON.stringify(dump, null, 1));
console.log('\n分量摘要写入 scripts/_skin_render/part_components.json');
