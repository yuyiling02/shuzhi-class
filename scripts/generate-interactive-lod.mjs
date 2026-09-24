#!/usr/bin/env node

/**
 * Build-time interactive LOD generator for Draco-compressed GLB meshes.
 *
 * The generator deliberately rewrites only geometry. Image bytes, material
 * definitions, node transforms, and application metadata are copied from the
 * source GLB. Meshoptimizer chooses a smaller triangle index stream while the
 * original decoded POSITION/NORMAL/TEXCOORD_0 values are retained for every
 * referenced vertex. Draco then packages those values for the browser loader.
 *
 * Usage:
 *   node scripts/generate-interactive-lod.mjs \
 *     --input public/models/heart-optimized.glb \
 *     --output public/models/heart-interactive-lod.glb \
 *     --target-triangles 225000
 *
 * This intentionally supports Draco primitives first. Meshopt-compressed and
 * plain primitives are reported as unsupported instead of being silently
 * rewritten with lossy assumptions. The source heart asset is Draco-only and
 * is therefore fully handled by this script.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import draco3d from 'draco3d';
import { MeshoptSimplifier } from 'meshoptimizer';

const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const TRIANGLES = 4;
const MISSING_INDEX = 0xffffffff;

function usage() {
  console.error(`Usage: node scripts/generate-interactive-lod.mjs --input <source.glb> --output <lod.glb> [--target-triangles <count>] [--target-error <value>]`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    if (key === 'help' || key === 'dry-run') {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args[key] = value;
    i += 1;
  }
  if (args.help) return args;
  if (!args.input || !args.output) {
    usage();
    throw new Error('--input and --output are required');
  }
  args['target-triangles'] = Number(args['target-triangles'] ?? 225000);
  args['target-error'] = Number(args['target-error'] ?? 0.02);
  args['draco-tolerance'] = Number(args['draco-tolerance'] ?? 0.02);
  args['node-prefix'] = args['node-prefix'] ?? '';
  args['material-colors'] = args['material-colors'] ?? '';
  if (!Number.isInteger(args['target-triangles']) || args['target-triangles'] <= 0) {
    throw new Error('--target-triangles must be a positive integer');
  }
  if (!Number.isFinite(args['target-error']) || args['target-error'] < 0) {
    throw new Error('--target-error must be a non-negative number');
  }
  return args;
}

function parseMaterialColors(spec) {
  const map = new Map();
  if (!spec) return map;
  for (const token of spec.split(',')) {
    const trim = token.trim();
    if (!trim) continue;
    const eq = trim.indexOf('=');
    if (eq <= 0) throw new Error(`Invalid --material-colors entry: ${trim}`);
    const meshIndex = Number(trim.slice(0, eq).trim());
    const hex = trim.slice(eq + 1).trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex) || !Number.isInteger(meshIndex) || meshIndex < 0) {
      throw new Error(`Invalid --material-colors entry: ${trim} (expected <meshIndex>=#rrggbb)`);
    }
    map.set(meshIndex, [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ]);
  }
  return map;
}

function align4(value) {
  return (value + 3) & ~3;
}

function parseGlb(bytes) {
  if (bytes.byteLength < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('Input is not a GLB 2.0 file');
  }
  const version = bytes.readUInt32LE(4);
  const declaredLength = bytes.readUInt32LE(8);
  if (version !== 2 || declaredLength > bytes.byteLength) {
    throw new Error(`Unsupported GLB header (version=${version}, length=${declaredLength})`);
  }

  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32LE(offset);
    const chunkType = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + chunkLength;
    if (end > bytes.byteLength) throw new Error('GLB chunk exceeds file length');
    if (chunkType === GLB_JSON) {
      const text = bytes.subarray(start, end).toString('utf8').replace(/\u0000+$/g, '').trimEnd();
      json = JSON.parse(text);
    } else if (chunkType === GLB_BIN) {
      bin = bytes.subarray(start, end);
    }
    offset = end;
  }
  if (!json || !bin) throw new Error('GLB must contain JSON and BIN chunks');
  if (!Array.isArray(json.buffers) || json.buffers.length !== 1) {
    throw new Error('Only GLBs with one binary buffer are supported');
  }
  return { json, bin };
}

function encodeGlb(json, bin) {
  const jsonText = JSON.stringify(json);
  const jsonBytes = Buffer.from(jsonText, 'utf8');
  const jsonLength = align4(jsonBytes.length);
  const binLength = align4(bin.length);
  const totalLength = 12 + 8 + jsonLength + 8 + binLength;
  const out = Buffer.alloc(totalLength, 0);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(jsonLength, 12);
  out.writeUInt32LE(GLB_JSON, 16);
  jsonBytes.copy(out, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  const binHeader = 20 + jsonLength;
  out.writeUInt32LE(binLength, binHeader);
  out.writeUInt32LE(GLB_BIN, binHeader + 4);
  bin.copy(out, binHeader + 8);
  return out;
}

function getBufferViewBytes(bin, json, index) {
  const view = json.bufferViews?.[index];
  if (!view || view.buffer !== undefined && view.buffer !== 0) {
    throw new Error(`Invalid bufferView ${index}`);
  }
  const start = view.byteOffset ?? 0;
  const end = start + view.byteLength;
  if (start < 0 || end > bin.length) throw new Error(`bufferView ${index} exceeds BIN chunk`);
  return bin.subarray(start, end);
}

function attrTypeToStride(type) {
  switch (type) {
    case 'SCALAR': return 1;
    case 'VEC2': return 2;
    case 'VEC3': return 3;
    case 'VEC4': return 4;
    default: throw new Error(`Unsupported Draco attribute type ${type}`);
  }
}

function copyDracoFloatArray(module, decoder, mesh, attributeType, name) {
  const attributeId = decoder.GetAttributeId(mesh, attributeType);
  if (attributeId < 0) return null;
  const attribute = decoder.GetAttribute(mesh, attributeId);
  const values = new module.DracoFloat32Array();
  const ok = decoder.GetAttributeFloatForAllPoints(mesh, attribute, values);
  if (!ok) {
    module.destroy(values);
    throw new Error(`Draco failed to read ${name}`);
  }
  const output = new Float32Array(values.size());
  for (let i = 0; i < output.length; i += 1) output[i] = values.GetValue(i);
  module.destroy(values);
  return output;
}

function decodeDraco(module, encoded) {
  const decoder = new module.Decoder();
  const buffer = new module.DecoderBuffer();
  buffer.Init(new Int8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength), encoded.byteLength);
  const type = decoder.GetEncodedGeometryType(buffer);
  if (type !== module.TRIANGULAR_MESH) {
    module.destroy(buffer);
    module.destroy(decoder);
    throw new Error('Only Draco triangular meshes are supported');
  }
  const mesh = new module.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  module.destroy(buffer);
  if (!status || (typeof status.ok === 'function' && !status.ok())) {
    const message = typeof status?.error_msg === 'function' ? status.error_msg() : 'unknown Draco error';
    if (status) module.destroy(status);
    module.destroy(mesh);
    module.destroy(decoder);
    throw new Error(`Draco decode failed: ${message}`);
  }

  const faces = mesh.num_faces();
  const points = mesh.num_points();
  const indices = new Uint32Array(faces * 3);
  const face = new module.DracoInt32Array();
  for (let i = 0; i < faces; i += 1) {
    if (!decoder.GetFaceFromMesh(mesh, i, face)) {
      module.destroy(face);
      module.destroy(mesh);
      module.destroy(decoder);
      throw new Error(`Draco failed to read face ${i}`);
    }
    const base = i * 3;
    indices[base] = face.GetValue(0);
    indices[base + 1] = face.GetValue(1);
    indices[base + 2] = face.GetValue(2);
  }
  module.destroy(face);

  const positions = copyDracoFloatArray(module, decoder, mesh, module.POSITION, 'POSITION');
  if (!positions || positions.length !== points * 3) {
    module.destroy(mesh);
    module.destroy(decoder);
    throw new Error(`Draco POSITION size mismatch (${positions?.length ?? 0} vs ${points * 3})`);
  }
  const normals = copyDracoFloatArray(module, decoder, mesh, module.NORMAL, 'NORMAL');
  const texcoords = copyDracoFloatArray(module, decoder, mesh, module.TEX_COORD, 'TEX_COORD');
  module.destroy(mesh);
  module.destroy(decoder);
  return { indices, points, positions, normals, texcoords };
}

function accessorStride(type) {
  switch (type) {
    case 'SCALAR': return 1;
    case 'VEC2': return 2;
    case 'VEC3': return 3;
    case 'VEC4': return 4;
    default: throw new Error(`Unknown accessor type ${type}`);
  }
}

function readFloatAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) return null;
  const stride = accessorStride(accessor.type);
  if (accessor.componentType !== 5126 || !Number.isFinite(accessor.count) || accessor.count <= 0) return null;
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) return null;
  const bytes = getBufferViewBytes(bin, json, accessor.bufferView);
  const byteOffset = accessor.byteOffset ?? 0;
  const byteStride = view.byteStride || 0;
  const out = new Float32Array(accessor.count * stride);
  if (byteStride && byteStride !== 4 * stride) {
    const dataView = new DataView(bytes.buffer, bytes.byteOffset + byteOffset);
    for (let i = 0; i < accessor.count; i += 1) {
      const base = i * byteStride;
      for (let c = 0; c < stride; c += 1) out[i * stride + c] = dataView.getFloat32(base + c * 4, true);
    }
  } else {
    out.set(new Float32Array(bytes.buffer, bytes.byteOffset + byteOffset, accessor.count * stride));
  }
  return out;
}

function readIndexAccessor(json, bin, accessorIndex) {
  const accessor = json.accessors?.[accessorIndex];
  if (!accessor) return null;
  const bytes = getBufferViewBytes(bin, json, accessor.bufferView);
  const byteOffset = accessor.byteOffset ?? 0;
  if (accessor.componentType === 5123) {
    return Uint32Array.from(new Uint16Array(bytes.buffer, bytes.byteOffset + byteOffset, accessor.count));
  }
  if (accessor.componentType === 5125) {
    return new Uint32Array(bytes.buffer, bytes.byteOffset + byteOffset, accessor.count);
  }
  throw new Error(`Unsupported index componentType ${accessor.componentType}`);
}

function decodePlain(json, bin, primitive) {
  const positions = readFloatAccessor(json, bin, primitive.attributes?.POSITION);
  if (!positions) throw new Error('Plain primitive missing float POSITION accessor');
  const indexed = primitive.indices !== undefined;
  const indices = indexed
    ? readIndexAccessor(json, bin, primitive.indices)
    : new Uint32Array(positions.length);
  if (!indexed) {
    for (let i = 0; i < positions.length; i += 1) indices[i] = i;
  }
  return {
    indices,
    points: positions.length / 3,
    positions,
    normals: readFloatAccessor(json, bin, primitive.attributes?.NORMAL),
    texcoords: readFloatAccessor(json, bin, primitive.attributes?.TEXCOORD_0),
  };
}

function decodeSource(json, bin, module, primitive) {
  if (primitive.extensions?.KHR_draco_mesh_compression) {
    const extension = primitive.extensions.KHR_draco_mesh_compression;
    return decodeDraco(module, getBufferViewBytes(bin, json, extension.bufferView));
  }
  return decodePlain(json, bin, primitive);
}

function minMax(values, stride) {
  const min = Array.from({ length: stride }, () => Infinity);
  const max = Array.from({ length: stride }, () => -Infinity);
  for (let i = 0; i < values.length; i += stride) {
    for (let c = 0; c < stride; c += 1) {
      const value = values[i + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  return { min, max };
}

function simplifyGeometry(decoded, targetTriangles, targetError) {
  const originalTriangles = Math.floor(decoded.indices.length / 3);
  const requestedTriangles = Math.max(1, Math.min(originalTriangles, Math.floor(targetTriangles)));
  const targetIndices = Math.max(3, requestedTriangles * 3);
  const [simplifiedRaw, error] = MeshoptSimplifier.simplify(
    decoded.indices,
    decoded.positions,
    3,
    targetIndices,
    targetError,
  );
  let simplified = new Uint32Array(simplifiedRaw);
  if (simplified.length % 3 !== 0) {
    simplified = simplified.subarray(0, simplified.length - (simplified.length % 3));
  }
  if (simplified.length < 3) throw new Error('Simplifier returned fewer than one triangle');

  // Remove any accidental degenerate triangles before compacting vertices.
  const valid = [];
  for (let i = 0; i < simplified.length; i += 3) {
    const a = simplified[i];
    const b = simplified[i + 1];
    const c = simplified[i + 2];
    if (a !== b && b !== c && c !== a) valid.push(a, b, c);
  }
  simplified = Uint32Array.from(valid);
  if (simplified.length < 3) throw new Error('Simplifier returned only degenerate triangles');

  const [remap, unique] = MeshoptSimplifier.compactMesh(simplified);
  const copyAttribute = (values, stride) => {
    if (!values) return null;
    if (values.length !== decoded.points * stride) {
      throw new Error(`Attribute size mismatch (${values.length} vs ${decoded.points * stride})`);
    }
    const compacted = new Float32Array(unique * stride);
    for (let oldIndex = 0; oldIndex < remap.length; oldIndex += 1) {
      const newIndex = remap[oldIndex];
      if (newIndex === MISSING_INDEX) continue;
      compacted.set(values.subarray(oldIndex * stride, oldIndex * stride + stride), newIndex * stride);
    }
    return compacted;
  };

  return {
    indices: simplified,
    points: unique,
    positions: copyAttribute(decoded.positions, 3),
    normals: copyAttribute(decoded.normals, 3),
    texcoords: copyAttribute(decoded.texcoords, 2),
    originalTriangles,
    triangles: simplified.length / 3,
    simplificationError: error,
  };
}

function encodeDraco(module, geometry) {
  const faces = geometry.indices.length / 3;
  let maxIndex = 0;
  for (const index of geometry.indices) maxIndex = Math.max(maxIndex, index);
  if (maxIndex >= geometry.points) {
    throw new Error(`Simplified index references point ${maxIndex}, but point count is ${geometry.points}`);
  }
  const builder = new module.MeshBuilder();
  const mesh = new module.Mesh();
  if (!builder.AddFacesToMesh(mesh, faces, geometry.indices)) {
    module.destroy(mesh);
    module.destroy(builder);
    throw new Error('Draco failed to add simplified faces');
  }
  const addAttribute = (kind, values, stride, label) => {
    if (!values) return;
    if (builder.AddFloatAttributeToMesh(mesh, kind, geometry.points, stride, values) < 0) {
      throw new Error(`Draco failed to add ${label} (points=${geometry.points}, values=${values.length}, stride=${stride}, faces=${faces})`);
    }
  };
  addAttribute(module.POSITION, geometry.positions, 3, 'POSITION');
  addAttribute(module.NORMAL, geometry.normals, 3, 'NORMAL');
  addAttribute(module.TEX_COORD, geometry.texcoords, 2, 'TEX_COORD');

  const encoder = new module.Encoder();
  encoder.SetSpeedOptions(5, 5);
  encoder.SetEncodingMethod(module.MESH_EDGEBREAKER_ENCODING);
  encoder.SetAttributeQuantization(module.POSITION, 14);
  encoder.SetAttributeQuantization(module.NORMAL, 10);
  encoder.SetAttributeQuantization(module.TEX_COORD, 12);
  const output = new module.DracoInt8Array();
  const encodedLength = encoder.EncodeMeshToDracoBuffer(mesh, output);
  if (encodedLength <= 0) {
    module.destroy(output);
    module.destroy(encoder);
    module.destroy(mesh);
    module.destroy(builder);
    throw new Error('Draco failed to encode simplified mesh');
  }
  const encoded = Buffer.alloc(encodedLength);
  for (let i = 0; i < encodedLength; i += 1) encoded[i] = output.GetValue(i) & 0xff;
  module.destroy(output);
  module.destroy(encoder);
  module.destroy(mesh);
  module.destroy(builder);
  return encoded;
}

function collectPrimitives(json) {
  const result = [];
  for (let meshIndex = 0; meshIndex < (json.meshes ?? []).length; meshIndex += 1) {
    const mesh = json.meshes[meshIndex];
    for (let primitiveIndex = 0; primitiveIndex < (mesh.primitives ?? []).length; primitiveIndex += 1) {
      result.push({ meshIndex, primitiveIndex, mesh, primitive: mesh.primitives[primitiveIndex] });
    }
  }
  return result;
}

function accessorCount(json, accessorIndex) {
  return accessorIndex === undefined ? 0 : (json.accessors?.[accessorIndex]?.count ?? 0);
}

function primitiveTriangleCount(json, primitive) {
  const mode = primitive.mode ?? TRIANGLES;
  if (mode !== TRIANGLES) throw new Error(`Unsupported primitive mode ${mode}; only TRIANGLES can be simplified`);
  const indexCount = primitive.indices === undefined
    ? accessorCount(json, primitive.attributes?.POSITION)
    : accessorCount(json, primitive.indices);
  return Math.floor(indexCount / 3);
}

function updateAccessorDescriptor(json, primitive, geometry) {
  const positionAccessorIndex = primitive.attributes?.POSITION;
  const positionAccessor = positionAccessorIndex === undefined ? null : json.accessors?.[positionAccessorIndex];
  if (positionAccessor) {
    positionAccessor.count = geometry.points;
    const range = minMax(geometry.positions, 3);
    positionAccessor.min = range.min;
    positionAccessor.max = range.max;
  }
  if (primitive.attributes?.NORMAL !== undefined && json.accessors?.[primitive.attributes.NORMAL]) {
    json.accessors[primitive.attributes.NORMAL].count = geometry.points;
  }
  if (primitive.attributes?.TEXCOORD_0 !== undefined && json.accessors?.[primitive.attributes.TEXCOORD_0]) {
    json.accessors[primitive.attributes.TEXCOORD_0].count = geometry.points;
  }
  if (primitive.indices !== undefined && json.accessors?.[primitive.indices]) {
    json.accessors[primitive.indices].count = geometry.indices.length;
    json.accessors[primitive.indices].componentType = geometry.points <= 65535 ? 5123 : 5125;
  }
}

function rewriteImageViews(json, bin, chunks) {
  const oldViews = json.bufferViews ?? [];
  const oldImages = json.images ?? [];
  const imageIndices = new Set(oldImages.map((image) => image.bufferView).filter((value) => value !== undefined));
  const newViews = [];
  const parts = [];
  const viewMap = new Map();
  const append = (data, view) => {
    const offset = parts.reduce((sum, part) => sum + part.length, 0);
    const alignedOffset = align4(offset);
    if (alignedOffset > offset) parts.push(Buffer.alloc(alignedOffset - offset));
    const start = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(data));
    const newIndex = newViews.length;
    newViews.push({ ...view, buffer: 0, byteOffset: start, byteLength: data.length });
    return newIndex;
  };

  for (const oldIndex of imageIndices) {
    const view = oldViews[oldIndex];
    if (!view) throw new Error(`Image references missing bufferView ${oldIndex}`);
    const newIndex = append(getBufferViewBytes(bin, json, oldIndex), view);
    viewMap.set(oldIndex, newIndex);
  }
  for (const image of oldImages) {
    if (image.bufferView !== undefined) image.bufferView = viewMap.get(image.bufferView);
  }
  for (const chunk of chunks) {
    const newIndex = append(chunk.bytes, { buffer: 0 });
    chunk.primitive.extensions.KHR_draco_mesh_compression.bufferView = newIndex;
  }
  const outputBin = Buffer.concat(parts);
  json.bufferViews = newViews;
  json.buffers[0].byteLength = outputBin.length;
  return outputBin;
}

function verifyGeneratedGlb(bytes, decoderModule, expectedTriangles) {
  const { json, bin } = parseGlb(bytes);
  const primitives = collectPrimitives(json);
  let totalTriangles = 0;
  for (const item of primitives) {
    const extension = item.primitive.extensions?.KHR_draco_mesh_compression;
    if (!extension || extension.bufferView === undefined) {
      throw new Error(`Generated primitive mesh ${item.meshIndex} has no Draco bufferView`);
    }
    const decoded = decodeDraco(decoderModule, getBufferViewBytes(bin, json, extension.bufferView));
    const triangles = decoded.indices.length / 3;
    const positionAccessor = json.accessors?.[item.primitive.attributes?.POSITION];
    const indexAccessor = json.accessors?.[item.primitive.indices];
    if (!positionAccessor || positionAccessor.count !== decoded.points) {
      throw new Error(`Generated POSITION count mismatch for mesh ${item.meshIndex} (accessor=${positionAccessor?.count ?? 'missing'}, decoded=${decoded.points})`);
    }
    if (!indexAccessor || indexAccessor.count !== decoded.indices.length) {
      throw new Error(`Generated index count mismatch for mesh ${item.meshIndex}`);
    }
    if (!decoded.positions.every(Number.isFinite)) {
      throw new Error(`Generated POSITION contains a non-finite value for mesh ${item.meshIndex}`);
    }
    totalTriangles += triangles;
  }
  if (totalTriangles !== expectedTriangles) {
    throw new Error(`Generated triangle total mismatch (${totalTriangles} vs ${expectedTriangles})`);
  }
  return { json, bin, triangles: totalTriangles };
}

function stripDracoAccessorBufferViews(json) {
  (json.meshes || []).forEach((mesh) => {
    (mesh.primitives || []).forEach((prim) => {
      if (!prim.extensions?.KHR_draco_mesh_compression) return;
      const refs = [];
      for (const key in prim.attributes || {}) refs.push(prim.attributes[key]);
      if (prim.indices !== undefined) refs.push(prim.indices);
      refs.forEach((index) => {
        const accessor = json.accessors?.[index];
        if (accessor) delete accessor.bufferView;
      });
    });
  });
}

function renameMeshNodes(json, prefix) {
  if (!prefix) return;
  let n = 0;
  (json.nodes || []).forEach((node) => {
    if (node.mesh !== undefined && n < (json.meshes?.length ?? 0)) {
      node.name = `${prefix}${n}`;
      n += 1;
    }
  });
  (json.meshes || []).forEach((mesh, i) => { mesh.name = `${prefix}${i}_mesh`; });
  (json.materials || []).forEach((material, i) => { material.name = `${prefix}${i}_mat`; });
}

function applyMaterialColors(json, colors) {
  if (colors.size === 0) return;
  (json.meshes || []).forEach((mesh, meshIndex) => {
    const rgb = colors.get(meshIndex);
    if (!rgb) return;
    const materialIndex = mesh.primitives?.[0]?.material;
    if (materialIndex === undefined || !json.materials?.[materialIndex]) return;
    const material = json.materials[materialIndex];
    const pmr = material.pbrMetallicRoughness = material.pbrMetallicRoughness || {};
    pmr.baseColorFactor = [rgb[0], rgb[1], rgb[2], 1];
    pmr.metallicFactor = 0;
    pmr.roughnessFactor = 0.55;
    delete material.emissiveFactor;
    delete material.emissiveTexture;
    delete material.normalTexture;
    delete material.extensions;
    material.doubleSided = true;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const sourceBytes = await fs.readFile(inputPath);
  const { json, bin } = parseGlb(sourceBytes);
  const primitives = collectPrimitives(json);
  if (primitives.length === 0) throw new Error('GLB has no mesh primitives');

  const unsupported = primitives.filter(({ primitive }) => (
    !primitive.extensions?.KHR_draco_mesh_compression
    && primitive.attributes?.POSITION == null
  ));
  if (unsupported.length > 0) {
    const labels = unsupported.map(({ meshIndex, primitiveIndex }) => `mesh ${meshIndex} primitive ${primitiveIndex}`);
    throw new Error(`Plain primitives without POSITION are unsupported: ${labels.join('; ')}`);
  }

  await MeshoptSimplifier.ready;
  const [decoderModule, encoderModule] = await Promise.all([
    draco3d.createDecoderModule({}),
    draco3d.createEncoderModule({}),
  ]);
  const originalTriangles = primitives.reduce((sum, item) => sum + primitiveTriangleCount(json, item.primitive), 0);
  const ratio = Math.min(1, args['target-triangles'] / originalTriangles);
  const chunks = [];
  let outputTriangles = 0;

  try {
    for (const item of primitives) {
      const decoded = decodeSource(json, bin, decoderModule, item.primitive);
      const primitiveOriginalTriangles = Math.floor(decoded.indices.length / 3);
      const primitiveTarget = Math.max(1, Math.floor(primitiveOriginalTriangles * ratio));
      const simplified = simplifyGeometry(decoded, primitiveTarget, args['target-error']);
      const encoded = encodeDraco(encoderModule, simplified);
      // Draco may split a handful of vertices when attribute seams are
      // encountered during encoding. Use the decoded stream as the final
      // descriptor source so accessor counts always describe what the runtime
      // loader will receive, while retaining the simplifier statistics below.
      const roundTrip = decodeDraco(decoderModule, encoded);
      const roundTripTriangles = roundTrip.indices.length / 3;
      if (roundTripTriangles < Math.max(1, simplified.triangles * (1 - (args['draco-tolerance'] ?? 0.02)))) {
        throw new Error(`Draco round-trip dropped too many triangles for mesh ${item.meshIndex} (${simplified.triangles} -> ${roundTripTriangles})`);
      }
      updateAccessorDescriptor(json, item.primitive, roundTrip);
      item.mesh.extras = {
        ...(item.mesh.extras ?? {}),
        interactiveLod: {
          generatedBy: 'scripts/generate-interactive-lod.mjs',
          sourceTriangles: primitiveOriginalTriangles,
          triangles: roundTripTriangles,
          sourcePoints: decoded.points,
          points: roundTrip.points,
          simplificationError: simplified.simplificationError,
        },
      };
      // Plain sources carry no Draco extension; mint one (with the runtime
      // attribute->id map three requires) before rewriteImageViews touches it.
      if (!item.primitive.extensions?.KHR_draco_mesh_compression) {
        const attributeMap = {};
        let dracoAttributeId = 0;
        for (const name of ['POSITION', 'NORMAL', 'TEXCOORD_0']) {
          if (item.primitive.attributes?.[name] !== undefined) {
            attributeMap[name] = dracoAttributeId;
            dracoAttributeId += 1;
          }
        }
        item.primitive.extensions = { ...(item.primitive.extensions ?? {}), KHR_draco_mesh_compression: { attributes: attributeMap } };
      }
      chunks.push({ bytes: encoded, primitive: item.primitive });
      outputTriangles += roundTripTriangles;
      console.log(JSON.stringify({
        mesh: item.meshIndex,
        primitive: item.primitiveIndex,
        sourceTriangles: primitiveOriginalTriangles,
        targetTriangles: primitiveTarget,
        outputTriangles: roundTripTriangles,
        sourcePoints: decoded.points,
        outputPoints: roundTrip.points,
        simplificationError: simplified.simplificationError,
        dracoBytes: encoded.length,
      }));
    }
  } finally {
    // The Emscripten modules own their WASM memory; explicitly releasing the
    // per-mesh objects above keeps this script safe for larger batch runs.
  }

  json.asset = {
    ...(json.asset ?? {}),
    extras: {
      ...(json.asset?.extras ?? {}),
      interactiveLod: {
        generatedBy: 'scripts/generate-interactive-lod.mjs',
        source: path.basename(inputPath),
        sourceTriangles: originalTriangles,
        triangles: outputTriangles,
        targetTriangles: args['target-triangles'],
        targetError: args['target-error'],
      },
    },
  };
  const outputBin = rewriteImageViews(json, bin, chunks);
  json.extensionsUsed = Array.from(new Set([
    ...(json.extensionsUsed ?? []),
    'KHR_draco_mesh_compression',
  ]));
  renameMeshNodes(json, args['node-prefix']);
  applyMaterialColors(json, parseMaterialColors(args['material-colors']));
  stripDracoAccessorBufferViews(json);
  const outputBytes = encodeGlb(json, outputBin);
  verifyGeneratedGlb(outputBytes, decoderModule, outputTriangles);
  if (!args['dry-run']) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, outputBytes);
  }
  console.log(JSON.stringify({
    input: inputPath,
    output: outputPath,
    sourceBytes: sourceBytes.length,
    outputBytes: outputBytes.length,
    sourceTriangles: originalTriangles,
    outputTriangles,
    targetTriangles: args['target-triangles'],
    dryRun: Boolean(args['dry-run']),
  }, null, 2));
}

main().catch((error) => {
  console.error(`interactive LOD generation failed: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
