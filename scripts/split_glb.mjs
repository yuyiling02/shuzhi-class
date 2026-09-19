// 用 Three.js + headless Edge 把单 mesh GLB 按解剖边界切成多 mesh
// node scripts/split_glb.mjs --input organ-brain.glb --output organ-brain.glb
// 分割逻辑在 splitRules() 里，根据模型名称应用不同规则
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i += 2) {
    out[args[i].replace(/^--/, '')] = args[i + 1];
  }
  return out;
}

// 返回 [{name, test}] —— test(cx, cy, cz, bb) 判断三角面中心归属哪块
function splitRules(modelName) {
  switch (modelName) {
    case 'organ-brain': {
      // 大脑：先切中线结构（下丘脑+脑干），再切小脑，最后按 X 分左右
      return [
        { name: '下丘脑', test: (cx, cy, cz, bb) => {
          const midX = (bb.min.x + bb.max.x) / 2;
          return Math.abs(cx - midX) < (bb.max.x - bb.min.x) * 0.08   // 中线内
              && cy > bb.min.y + (bb.max.y - bb.min.y) * 0.35          // 下半部但不是最底
              && cz > bb.min.z + (bb.max.z - bb.min.z) * 0.30;        // 靠前
        }},
        { name: '脑干', test: (cx, cy, cz, bb) => {
          const midX = (bb.min.x + bb.max.x) / 2;
          return Math.abs(cx - midX) < (bb.max.x - bb.min.x) * 0.06   // 极窄中线
              && cy < bb.min.y + (bb.max.y - bb.min.y) * 0.25;        // 最底部
        }},
        { name: '小脑', test: (cx, cy, cz, bb) => {
          return cy < bb.min.y + (bb.max.y - bb.min.y) * 0.20         // 极底部
              && cz < bb.max.z - (bb.max.z - bb.min.z) * 0.10;        // 后下方
        }},
        // 剩下的按 X=midX 切左右
        { name: '左脑', test: (cx, _cy, _cz, bb) => cx < (bb.min.x + bb.max.x) / 2 },
        { name: '右脑', test: (cx, _cy, _cz, bb) => cx >= (bb.min.x + bb.max.x) / 2 },
      ];
    }
    case 'organ-heart': {
      // 心脏：先切顶部大血管，再按 X 分左右心
      return [
        { name: '大血管', test: (_cx, cy, cz, bb) => {
          const midX = (bb.min.x + bb.max.x) / 2;
          return cy > bb.min.y + (bb.max.y - bb.min.y) * 0.78          // 顶部
              && Math.abs(cz - (bb.min.z + bb.max.z) / 2) < (bb.max.z - bb.min.z) * 0.15;
        }},
        { name: '左心', test: (cx, _cy, _cz, bb) => cx < (bb.min.x + bb.max.x) / 2 },
        { name: '右心', test: (cx, _cy, _cz, bb) => cx >= (bb.min.x + bb.max.x) / 2 },
      ];
    }
    case 'organ-lungs': {
      // 肺：先切中间气管，再按 X 分左右肺
      return [
        { name: '气管', test: (cx, _cy, cz, bb) => {
          const midX = (bb.min.x + bb.max.x) / 2;
          const midZ = (bb.min.z + bb.max.z) / 2;
          return Math.abs(cx - midX) < (bb.max.x - bb.min.x) * 0.07   // 中线
              && Math.abs(cz - midZ) < (bb.max.z - bb.min.z) * 0.15;
        }},
        { name: '左肺', test: (cx, _cy, _cz, bb) => cx < (bb.min.x + bb.max.x) / 2 },
        { name: '右肺', test: (cx, _cy, _cz, bb) => cx >= (bb.min.x + bb.max.x) / 2 },
      ];
    }
    default:
      return [];
  }
}

async function main() {
  const args = parseArgs();
  const modelName = args.input?.replace('.glb', '') || 'organ-brain';
  const inputPath = path.resolve(ROOT, args.input || `public/models/${modelName}.glb`);
  const outputPath = path.resolve(ROOT, args.output || `public/models/${modelName}.glb`);

  console.log(`切分: ${modelName}`);
  console.log(`输入: ${inputPath}`);
  console.log(`输出: ${outputPath}`);

  const edgePaths = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  let executablePath;
  for (const p of edgePaths) {
    try { await import('node:fs/promises').then(fs => fs.access(p)); executablePath = p; break; } catch {}
  }
  if (!executablePath) throw new Error('找不到 Edge 浏览器');

  const browser = await puppeteer.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-gpu', '--headless=new'],
  });
  const page = await browser.newPage();

  const rules = splitRules(modelName);
  if (rules.length === 0) { await browser.close(); throw new Error(`无切分规则: ${modelName}`); }
  console.log(`规则: ${rules.map(r => r.name).join(', ')}`);

  const result = await page.evaluate(async ({ rules, glbUrl }) => {
    const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
    const DRACO_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';
    const GLTF_URL  = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

    // 用 importmap 加载
    const importmap = document.createElement('script');
    importmap.type = 'importmap';
    importmap.textContent = JSON.stringify({ imports: {
      'three': THREE_URL,
      'three/': 'https://cdn.jsdelivr.net/npm/three@0.160.0/',
    }});
    document.head.appendChild(importmap);

    const [THREE, { GLTFLoader }, { DRACOLoader }] = await Promise.all([
      import('three'),
      import('three/examples/jsm/loaders/GLTFLoader.js'),
      import('three/examples/jsm/loaders/DRACOLoader.js'),
    ]);

    const loader = new GLTFLoader();
    const draco = new DRACOLoader();
    draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/');
    draco.setDecoderConfig({ type: 'wasm' });
    loader.setDRACOLoader(draco);

    return new Promise((resolve, reject) => {
      loader.load(glbUrl, (gltf) => {
        const scene = gltf.scene;

        // 合并所有 mesh 到一个几何体（假设单 mesh）
        let masterGeo = null;
        scene.traverse((obj) => {
          if (obj.isMesh && !masterGeo) masterGeo = obj.geometry;
        });
        if (!masterGeo) return reject(new Error('没找到 mesh'));

        // 计算包围盒
        const bbox = new THREE.Box3().setFromObject(scene);
        const bb = { min: { x: bbox.min.x, y: bbox.min.y, z: bbox.min.z },
                     max: { x: bbox.max.x, y: bbox.max.y, z: bbox.max.z } };

        const pos = masterGeo.attributes.position;
        const idx = masterGeo.index;
        const totalTriangles = idx ? idx.count / 3 : pos.count / 3;

        // 每个三角面归到一块
        const triAssign = new Array(totalTriangles).fill(-1);
        for (let t = 0; t < totalTriangles; t++) {
          let ax, ay, az, bx, by, bz, cx, cy, cz;
          if (idx) {
            const i0 = idx.getX(t*3), i1 = idx.getX(t*3+1), i2 = idx.getX(t*3+2);
            ax = pos.getX(i0); ay = pos.getY(i0); az = pos.getZ(i0);
            bx = pos.getX(i1); by = pos.getY(i1); bz = pos.getZ(i1);
            cx = pos.getX(i2); cy = pos.getY(i2); cz = pos.getZ(i2);
          } else {
            const i = t*3;
            ax = pos.getX(i); ay = pos.getY(i); az = pos.getZ(i);
            bx = pos.getX(i+1); by = pos.getY(i+1); bz = pos.getZ(i+1);
            cx = pos.getX(i+2); cy = pos.getY(i+2); cz = pos.getZ(i+2);
          }
          const gx = (ax+bx+cx)/3, gy = (ay+by+cy)/3, gz = (az+bz+cz)/3;
          for (let r = 0; r < rules.length; r++) {
            if (rules[r].test(gx, gy, gz, bb)) { triAssign[t] = r; break; }
          }
        }

        // 按块构建新 geometry
        const parts = [];
        for (let r = 0; r < rules.length; r++) {
          const triCount = triAssign.filter(x => x === r).length;
          if (triCount === 0) continue;
          const newIdx = new Uint32Array(triCount * 3);
          let write = 0;
          for (let t = 0; t < totalTriangles; t++) {
            if (triAssign[t] === r) {
              if (idx) {
                newIdx[write++] = idx.getX(t*3);
                newIdx[write++] = idx.getX(t*3+1);
                newIdx[write++] = idx.getX(t*3+2);
              } else {
                newIdx[write++] = t*3;
                newIdx[write++] = t*3+1;
                newIdx[write++] = t*3+2;
              }
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', pos);
          geo.setIndex(newIdx);
          geo.computeVertexNormals();
          parts.push({ name: rules[r].name, geometry: geo });
        }

        // 用 GLTFExporter 导出
        const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
        const exporter = new GLTFExporter();
        const group = new THREE.Group();
        parts.forEach(p => {
          const mat = masterGeo.material || new THREE.MeshStandardMaterial({ color: 0xcccccc });
          const mesh = new THREE.Mesh(p.geometry, mat.clone());
          mesh.userData.teachingRole = 'disassembly-part';
          mesh.name = p.name;
          group.add(mesh);
        });
        scene.clear();
        scene.add(group);

        exporter.parse(group, (gltf) => {
          // 返回 ArrayBuffer
          resolve({
            glb: gltf,
            parts: parts.map(p => ({ name: p.name, triangles: p.geometry.index.count / 3 })),
          });
        }, (err) => reject(err), { binary: true });
      }, (err) => reject(err));
    });
  }, { rules, glbUrl: `http://localhost:4000/models/${modelName}.glb` });

  await browser.close();

  writeFileSync(outputPath, Buffer.from(result.glb));
  const parts = result.parts.map(p => `${p.name}(${p.triangles.toLocaleString()})`).join(', ');
  console.log(`✓ 完成: ${parts}`);
  console.log(`→ ${outputPath} (${(result.glb.byteLength / 1024 / 1024).toFixed(1)} MB)`);
}

main().catch(err => { console.error('切分失败:', err.message || err); process.exit(1); });
