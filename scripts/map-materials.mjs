import fs from 'node:fs';

const file = process.argv[2];
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));

const meshByNode = new Map();
for (const node of json.nodes || []) {
  if (node.mesh !== undefined) meshByNode.set(node.name, node.mesh);
}

console.log('=== meshes (primitives -> material, materialName, doubleSided) ===');
for (let i = 0; i < (json.meshes || []).length; i++) {
  const m = json.meshes[i];
  const mats = (m.primitives || []).map(p => {
    const mo = p.material !== undefined ? json.materials[p.material] : null;
    return `mat${p.material}(${mo ? mo.name : 'NONE'})`;
  });
  console.log('mesh', i, m.name, '->', mats.join(','));
}
console.log('=== nodes with mesh ===');
for (const [n, mi] of meshByNode) {
  const m = json.meshes[mi];
  const p = m.primitives[0];
  const mat = p.material !== undefined ? json.materials[p.material] : null;
  console.log('node', JSON.stringify(n), '-> mesh', mi, 'material', mat ? mat.name : '(none)');
}
const unassigned = (json.meshes || []).some(m =>
  (m.primitives || []).some(p => p.material === undefined)
);
console.log('any primitive WITHOUT material?', unassigned);