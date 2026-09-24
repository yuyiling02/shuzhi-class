import fs from 'node:fs';

const file = process.argv[2];
const b = fs.readFileSync(file);
const jsonLen = b.readUInt32LE(12);
const binStart = 20 + jsonLen;
const json = JSON.parse(b.toString('utf8', 20, binStart).replace(/\0+$/g, ''));
const buf = b.subarray(binStart, binStart + b.readUInt32LE(16));

function readPositions(attribIndex) {
  const a = json.accessors[attribIndex];
  const v = json.bufferViews[a.bufferView];
  const off = (v.byteOffset || 0) + (a.byteOffset || 0);
  const comp = a.componentType === 5126 ? 4 : 2;
  const data = [];
  for (let i = 0; i < a.count * 3; i++) {
    const p = off + i * comp;
    data.push(comp === 4 ? buf.readFloatLE(p) : buf.readInt16LE(p));
  }
  return { data, count: a.count };
}

function bbox(data) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (data[i + k] < mn[k]) mn[k] = data[i + k];
      if (data[i + k] > mx[k]) mx[k] = data[i + k];
    }
  }
  return { mn, mx, cen: mn.map((v, k) => (v + mx[k]) / 2), size: mx.map((v, k) => (v - mn[k])) };
}

for (const mesh of json.meshes || []) {
  const p = mesh.primitives[0];
  const attrIndex = p.attributes.POSITION;
  const { data } = readPositions(attrIndex);
  const bb = bbox(data);
  console.log(mesh.name, 'tris=', p.indices !== undefined ? json.accessors[p.indices].count / 3 : data.length / 9,
    'size=', bb.size.map(v => v.toFixed(3)),
    'cen=', bb.cen.map(v => v.toFixed(3)));
}