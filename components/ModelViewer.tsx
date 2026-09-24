
import React, { useRef, Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, ContactShadows, Html } from '@react-three/drei';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { clone as cloneSkinnedModel } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { ControlRefs, ModelType } from '../types';
import { resolveModelAssetUrl } from '../services/modelAssetUrl';
import {
  consumePublishedHandInput,
  performanceTelemetry,
} from '../services/performanceTelemetry';
import {
  advanceDragGestureSession,
  createDragGestureSessionState,
  selectDragPickCandidate,
} from '../services/dragInteraction';
import { ProceduralTerrain } from './ProceduralTerrain';
import { useTheme } from './ThemeProvider';

// Fix for TypeScript errors regarding R3F intrinsic elements and missing HTML elements
declare global {
  namespace JSX {
    interface IntrinsicElements {
      group: any;
      primitive: any;
      ambientLight: any;
      spotLight: any;
      pointLight: any;
      mesh: any;
      planeGeometry: any;
      meshStandardMaterial: any;
      [elemName: string]: any;
    }
  }
}

type CameraTarget = [number, number, number];

interface LoadProgress {
  loaded: number;
  total: number;
  percent: number;
}

interface ModelLoadError {
  title: string;
  detail: string;
}

interface ModelViewerProps {
  modelUrl: string;
  modelType: ModelType;
  assetUrls?: Record<string, string>;
  controlRef: React.MutableRefObject<ControlRefs>;
  showLabels?: boolean;
  onShowLabelsChange?: (val: boolean) => void;
  onLoadProgress?: (progress: LoadProgress) => void;
  onLoadComplete?: () => void;
  onLoadError?: (error: ModelLoadError) => void;
  onPartMoved?: (partName: string) => void;
  onDisassemblyAvailabilityChange?: (available: boolean) => void;
  quizMode?: boolean;  // 新增：是否处于答题模式
  presentationSplitActive?: boolean;
}

const MODEL_BASE_Y = -0.49;
const MODEL_TARGET_SIZE = 1.5;
const EARTH_LAYERS_TARGET_SIZE = 3.0;
const EARTH_POLITICAL_TARGET_SIZE = 3.5;
const MODEL_SHADOW_TRIANGLE_BUDGET = 250_000;
const MAX_RENDER_DPR = 1.25;
const STABLE_RENDER_DPR = 1.5;
const INTERACTIVE_LOD_URL_BY_KEY: Record<string, string> = {
  'heart-optimized.glb': '/models/heart-interactive-lod.glb',
  'hiv-virus.glb': '/models/hiv-virus-interactive-lod.glb',
  'organ-brain.glb': '/models/organ-brain-interactive-lod.glb',
  'organ-eyeball.glb': '/models/organ-eyeball-interactive-lod.glb',
  'organ-heart.glb': '/models/organ-heart-interactive-lod.glb',
  'organ-intestine.glb': '/models/organ-intestine-disassemblable.glb',
  'organ-kidneys.glb': '/models/organ-kidneys-interactive-lod.glb',
  'organ-liver.glb': '/models/organ-liver-interactive-lod.glb',
  'organ-lungs.glb': '/models/organ-lungs-interactive-lod.glb',
  'organ-pancreas.glb': '/models/organ-pancreas-disassemblable.glb',
  'organ-skin.glb': '/models/organ-skin-disassemblable.glb',
};
const PUBCHEM_6233_MODEL_KEY = 'pubchem-6233-bas-color-print_nih3d.glb';
const NITROBENZENE_MODEL_KEY = '7416-bas-color-print_nih3d.glb';
const DIAMOND_UNIT_CELL_KEY = 'diamond-unit-cell_nih3d.glb';
const DIAMOND_MODEL_KEY = 'diamond.glb';

type GrabbablePart = THREE.Object3D;
type HighlightMaterial = THREE.Material & { emissive?: THREE.Color };
interface DragPickProxy {
  part: GrabbablePart;
  localBox: THREE.Box3;
  worldBox: THREE.Box3;
}

type PubchemPartKind = 'left-methyl' | 'right-methyl' | 'core';
type NitrobenzenePartKind = 'nitro' | 'remainder';

const vectorFromTarget = (target: CameraTarget) => new THREE.Vector3(target[0], target[1], target[2]);
const PART_MOVE_LOG_THRESHOLD = 0.03;

const isMeshObject = (object: THREE.Object3D): object is THREE.Mesh => {
  return Boolean((object as THREE.Mesh).isMesh);
};

const getReadablePartLabel = (part: GrabbablePart): string => {
  const label = part.name.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return label || '未命名部件';
};

const hasRenderableMesh = (object: THREE.Object3D): boolean => {
  let found = false;
  object.traverse((child) => {
    if (!found && isMeshObject(child)) {
      found = true;
    }
  });
  return found;
};

const collectMeshes = (object: THREE.Object3D): THREE.Mesh[] => {
  const meshes: THREE.Mesh[] = [];
  object.traverse((child) => {
    if (isMeshObject(child)) {
      meshes.push(child);
    }
  });
  return meshes;
};

const collectHighlightMaterials = (part: GrabbablePart): HighlightMaterial[] => {
  const materials = new Set<HighlightMaterial>();

  part.traverse((child) => {
    if (!isMeshObject(child) || !child.material) return;

    const meshMaterials = Array.isArray(child.material) ? child.material : [child.material];
    meshMaterials.forEach((material) => {
      const highlightMaterial = material as HighlightMaterial;
      if (highlightMaterial.emissive) {
        materials.add(highlightMaterial);
      }
    });
  });

  return Array.from(materials);
};

const createDragPickProxy = (part: GrabbablePart): DragPickProxy | null => {
  part.updateWorldMatrix(true, true);

  const inversePartMatrix = new THREE.Matrix4().copy(part.matrixWorld).invert();
  const localBox = new THREE.Box3();
  const meshLocalBox = new THREE.Box3();

  collectMeshes(part).forEach((mesh) => {
    if (!mesh.geometry) return;
    if (!mesh.geometry.boundingBox) {
      mesh.geometry.computeBoundingBox();
    }
    if (!mesh.geometry.boundingBox) return;

    mesh.updateWorldMatrix(true, false);
    meshLocalBox.copy(mesh.geometry.boundingBox)
      .applyMatrix4(mesh.matrixWorld)
      .applyMatrix4(inversePartMatrix);
    localBox.union(meshLocalBox);
  });

  if (localBox.isEmpty()) {
    const fallbackWorldBox = new THREE.Box3().setFromObject(part);
    if (fallbackWorldBox.isEmpty()) return null;
    localBox.copy(fallbackWorldBox).applyMatrix4(inversePartMatrix);
  }

  return {
    part,
    localBox: localBox.clone(),
    worldBox: new THREE.Box3(),
  };
};

const findLayerRoots = (root: THREE.Object3D): GrabbablePart[] => {
  const explicitDisassemblyRoots: GrabbablePart[] = [];
  root.traverse((node) => {
    if (node.userData?.teachingRole === 'disassembly-part' && hasRenderableMesh(node)) {
      explicitDisassemblyRoots.push(node);
    }
  });

  if (explicitDisassemblyRoots.length > 0) {
    return explicitDisassemblyRoots;
  }

  const explicitLayerRoots: GrabbablePart[] = [];
  root.traverse((node) => {
    if (node.userData?.teachingRole === 'earth-internal-layer' && hasRenderableMesh(node)) {
      explicitLayerRoots.push(node);
    }
  });

  if (explicitLayerRoots.length > 1) {
    const layerOrder = new Map([
      ['Crust', 0],
      ['Mantle', 1],
      ['OuterCore', 2],
      ['InnerCore', 3],
    ]);
    return explicitLayerRoots.sort((a, b) => (layerOrder.get(a.name) ?? 99) - (layerOrder.get(b.name) ?? 99));
  }

  const walk = (node: THREE.Object3D): GrabbablePart[] => {
    const childrenWithMeshes = node.children.filter(hasRenderableMesh);

    if (childrenWithMeshes.length > 1) {
      return childrenWithMeshes;
    }

    if (childrenWithMeshes.length === 1) {
      return walk(childrenWithMeshes[0]);
    }

    return collectMeshes(node);
  };

  const layerRoots = walk(root);
  if (layerRoots.length > 1) {
    return layerRoots;
  }

  const meshParts = collectMeshes(root);
  return meshParts.length > 1 ? meshParts : [];
};

const isDescendantOf = (object: THREE.Object3D, ancestor: THREE.Object3D): boolean => {
  let current: THREE.Object3D | null = object;

  while (current) {
    if (current === ancestor) {
      return true;
    }
    current = current.parent;
  }

  return false;
};

const configureModel = (root: THREE.Object3D, targetSize = MODEL_TARGET_SIZE) => {
  root.scale.set(1, 1, 1);
  root.position.set(0, 0, 0);

  let box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);

  if (maxDim > 0 && Number.isFinite(maxDim)) {
    root.scale.setScalar(targetSize / maxDim);
  }

  box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, MODEL_BASE_Y - box.min.y, -center.z);

  let triangleCount = 0;
  root.traverse((child) => {
    if (!isMeshObject(child) || !child.geometry) return;
    const index = child.geometry.getIndex();
    const position = child.geometry.getAttribute('position');
    triangleCount += index ? index.count / 3 : (position?.count ?? 0) / 3;
  });
  const canCastRealtimeShadow = triangleCount <= MODEL_SHADOW_TRIANGLE_BUDGET;

  root.traverse((child) => {
    if (isMeshObject(child)) {
      // High-poly models otherwise render their full geometry again for the
      // shadow map on every frame. Contact/environment lighting still grounds
      // them visually without that extra multi-million-triangle pass.
      child.castShadow = canCastRealtimeShadow;
      child.receiveShadow = true;

      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach((material: any) => {
        if (material) {
          material.envMapIntensity = 1.2;
          // Ensure solid rendering: force depth writes and disable transparency
          // for base earth surfaces so the globe appears solid, not see-through.
          material.depthWrite = true;
          if (material.transparent && material.opacity !== undefined && material.opacity < 0.9) {
            // Keep atmosphere glow transparent, but boost its base color for visibility
            if (material.opacity < 0.5) {
              material.opacity = Math.max(material.opacity, 0.25);
            }
          }
        }
      });
    }
  });
};

const enhanceDiamondModel = (root: THREE.Object3D) => {
  const atomsNode = root.getObjectByName('atoms') as THREE.Mesh | null;
  const bondsNode = root.getObjectByName('bonds') as THREE.Mesh | null;

  // Carbon atom material — crystalline diamond look
  const atomMaterial = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#e8f4fd'),
    metalness: 0.05,
    roughness: 0.18,
    clearcoat: 0.35,
    clearcoatRoughness: 0.15,
    reflectivity: 1.0,
    envMapIntensity: 1.6,
    specularIntensity: 0.7,
    specularColor: new THREE.Color('#c8e8ff'),
  });

  // Covalent bond material — subtle metallic gray
  const bondMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#b0bec5'),
    metalness: 0.3,
    roughness: 0.35,
    envMapIntensity: 1.0,
  });

  if (atomsNode && isMeshObject(atomsNode)) {
    atomsNode.material = atomMaterial;
    atomsNode.castShadow = true;
    atomsNode.receiveShadow = true;
  }

  if (bondsNode && isMeshObject(bondsNode)) {
    bondsNode.material = bondMaterial;
    bondsNode.castShadow = true;
    bondsNode.receiveShadow = true;
  }

  // Also traverse to catch any unnamed meshes
  root.traverse((child) => {
    if (!isMeshObject(child) || child === atomsNode || child === bondsNode) return;
    const name = child.name.toLowerCase();
    if (name.includes('atom') || name.includes('carbon') || name.includes('c_')) {
      child.material = atomMaterial;
    } else if (name.includes('bond')) {
      child.material = bondMaterial;
    }
  });
};

const setPartHighlight = (part: GrabbablePart, color: number) => {
  part.traverse((child) => {
    if (!isMeshObject(child) || !child.material) return;

    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material: any) => {
      if (material.emissive) {
        material.emissive.setHex(color);
      }
    });
  });
};

const getAssetKey = (url: string): string => {
  const cleanUrl = url.split(/[?#]/)[0];
  const decodedUrl = decodeURIComponent(cleanUrl);
  return decodedUrl.substring(decodedUrl.lastIndexOf('/') + 1).toLowerCase();
};

const isPubchem6233Model = (url: string): boolean => getAssetKey(url) === PUBCHEM_6233_MODEL_KEY;

const isNitrobenzeneModel = (url: string): boolean => getAssetKey(url) === NITROBENZENE_MODEL_KEY;

const isDiamondUnitCellModel = (url: string): boolean => getAssetKey(url) === DIAMOND_UNIT_CELL_KEY;

const isDiamondModel = (url: string): boolean => getAssetKey(url) === DIAMOND_MODEL_KEY;

const classifyPubchemAtomTriangle = (center: THREE.Vector3): PubchemPartKind => {
  if (center.x < -2.05) return 'left-methyl';
  if (center.x > 2.05) return 'right-methyl';
  return 'core';
};

const classifyPubchemBondTriangle = (center: THREE.Vector3): PubchemPartKind => {
  if (center.x < -2.15) return 'left-methyl';
  if (center.x > 2.15) return 'right-methyl';
  return 'core';
};

const isPubchemMethylHydrogenSite = (center: THREE.Vector3): boolean => (
  Math.abs(center.x) > 3.05 &&
  center.y < -0.75
);

const getAttributeColorComponent = (attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, index: number, component: number): number => {
  if (!attribute) return 1;

  const value = component === 0
    ? attribute.getX(index)
    : component === 1
      ? attribute.getY(index)
      : component === 2
        ? attribute.getZ(index)
        : 1;

  return value > 1 ? value / 255 : value;
};

const clonePubchemMaterial = (source: THREE.Mesh): THREE.Material => {
  const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material;
  const material = sourceMaterial?.clone() ?? new THREE.MeshStandardMaterial({
    roughness: 0.62,
    metalness: 0,
  });

  if ('vertexColors' in material) {
    (material as THREE.MeshStandardMaterial).vertexColors = true;
  }
  material.side = THREE.DoubleSide;
  material.depthWrite = true;
  material.userData.__ownedTextures = false;
  return material;
};

/**
 * Use a pre-built interactive mesh for known high-poly built-ins. Uploaded
 * assets and remote mappings stay untouched: they may have application-
 * specific semantics (or no safe offline simplification) that we cannot
 * infer at runtime.
 */
const resolveInteractiveModelUrl = (url: string, assetUrls?: Record<string, string>) => {
  if (assetUrls && Object.keys(assetUrls).length > 0) return url;
  return INTERACTIVE_LOD_URL_BY_KEY[getAssetKey(url)] || url;
};

const createPubchemSubsetMesh = (
  source: THREE.Mesh,
  partKind: PubchemPartKind,
  classifier: (center: THREE.Vector3) => PubchemPartKind,
  recolorHydrogenSites: boolean,
): THREE.Mesh | null => {
  const geometry = source.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();

  if (!position || !index) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const center = new THREE.Vector3();

  const pushVertex = (vertexIndex: number, useHydrogenColor: boolean) => {
    positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));

    if (normal) {
      normals.push(normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex));
    }

    if (useHydrogenColor) {
      colors.push(1, 1, 1);
    } else {
      colors.push(
        getAttributeColorComponent(color, vertexIndex, 0),
        getAttributeColorComponent(color, vertexIndex, 1),
        getAttributeColorComponent(color, vertexIndex, 2),
      );
    }
  };

  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);

    a.set(position.getX(ia), position.getY(ia), position.getZ(ia));
    b.set(position.getX(ib), position.getY(ib), position.getZ(ib));
    c.set(position.getX(ic), position.getY(ic), position.getZ(ic));
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    if (classifier(center) !== partKind) continue;

    const useHydrogenColor = recolorHydrogenSites && isPubchemMethylHydrogenSite(center);
    pushVertex(ia, useHydrogenColor);
    pushVertex(ib, useHydrogenColor);
    pushVertex(ic, useHydrogenColor);
  }

  if (positions.length === 0) return null;

  const subsetGeometry = new THREE.BufferGeometry();
  subsetGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length > 0) {
    subsetGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    subsetGeometry.computeVertexNormals();
  }
  subsetGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  subsetGeometry.computeBoundingBox();
  subsetGeometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(subsetGeometry, clonePubchemMaterial(source));
  mesh.userData.__ownedGeometry = true;
  mesh.name = `${source.name || 'pubchem'}-${partKind}`;
  mesh.castShadow = source.castShadow;
  mesh.receiveShadow = source.receiveShadow;
  mesh.position.copy(source.position);
  mesh.quaternion.copy(source.quaternion);
  mesh.scale.copy(source.scale);
  return mesh;
};

const isNitrobenzeneNitroColor = (color: THREE.Vector4): boolean => {
  const isOxygenRed = color.x > 0.75 && color.y < 0.35 && color.z < 0.35;
  const isNitrogenBlue = color.z > 0.55 && color.x < 0.45 && color.y < 0.65;
  return isOxygenRed || isNitrogenBlue;
};

const createNitrobenzeneSubsetMesh = (
  source: THREE.Mesh,
  partKind: NitrobenzenePartKind,
  includeNitro: (center: THREE.Vector3, color: THREE.Vector4) => boolean,
): THREE.Mesh | null => {
  const geometry = source.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const color = geometry.getAttribute('color');
  const index = geometry.getIndex();

  if (!position || !index) return null;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const center = new THREE.Vector3();
  const triangleColor = new THREE.Vector4();

  const pushVertex = (vertexIndex: number) => {
    positions.push(position.getX(vertexIndex), position.getY(vertexIndex), position.getZ(vertexIndex));

    if (normal) {
      normals.push(normal.getX(vertexIndex), normal.getY(vertexIndex), normal.getZ(vertexIndex));
    }

    colors.push(
      getAttributeColorComponent(color, vertexIndex, 0),
      getAttributeColorComponent(color, vertexIndex, 1),
      getAttributeColorComponent(color, vertexIndex, 2),
    );
  };

  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i);
    const ib = index.getX(i + 1);
    const ic = index.getX(i + 2);

    a.set(position.getX(ia), position.getY(ia), position.getZ(ia));
    b.set(position.getX(ib), position.getY(ib), position.getZ(ib));
    c.set(position.getX(ic), position.getY(ic), position.getZ(ic));
    center.copy(a).add(b).add(c).multiplyScalar(1 / 3);

    triangleColor.set(0, 0, 0, 0);
    [ia, ib, ic].forEach((vertexIndex) => {
      triangleColor.x += getAttributeColorComponent(color, vertexIndex, 0) / 3;
      triangleColor.y += getAttributeColorComponent(color, vertexIndex, 1) / 3;
      triangleColor.z += getAttributeColorComponent(color, vertexIndex, 2) / 3;
      triangleColor.w += getAttributeColorComponent(color, vertexIndex, 3) / 3;
    });

    const isNitro = includeNitro(center, triangleColor);
    if ((partKind === 'nitro') !== isNitro) continue;

    pushVertex(ia);
    pushVertex(ib);
    pushVertex(ic);
  }

  if (positions.length === 0) return null;

  const subsetGeometry = new THREE.BufferGeometry();
  subsetGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length > 0) {
    subsetGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  } else {
    subsetGeometry.computeVertexNormals();
  }
  subsetGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  subsetGeometry.computeBoundingBox();
  subsetGeometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(subsetGeometry, clonePubchemMaterial(source));
  mesh.userData.__ownedGeometry = true;
  mesh.name = `${source.name || 'nitrobenzene'}-${partKind}`;
  mesh.castShadow = source.castShadow;
  mesh.receiveShadow = source.receiveShadow;
  mesh.position.copy(source.position);
  mesh.quaternion.copy(source.quaternion);
  mesh.scale.copy(source.scale);
  return mesh;
};

const prepareNitrobenzeneModel = (root: THREE.Object3D): GrabbablePart[] => {
  const atoms = root.getObjectByName('atoms') as THREE.Mesh | undefined;
  const bonds = root.getObjectByName('bonds') as THREE.Mesh | undefined;

  if (!atoms || !bonds || !isMeshObject(atoms) || !isMeshObject(bonds)) {
    return [];
  }

  const parent = atoms.parent ?? root;
  const nitroGroup = new THREE.Group();
  const remainderGroup = new THREE.Group();
  nitroGroup.name = 'Nitrobenzene nitro group';
  remainderGroup.name = 'Nitrobenzene fixed benzene body';
  nitroGroup.userData.teachingRole = 'disassembly-part';

  const includeNitroAtoms = (_center: THREE.Vector3, color: THREE.Vector4) => isNitrobenzeneNitroColor(color);
  const includeNitroBonds = (center: THREE.Vector3, color: THREE.Vector4) => (
    isNitrobenzeneNitroColor(color) || center.x > 0.95
  );

  const nitroAtoms = createNitrobenzeneSubsetMesh(atoms, 'nitro', includeNitroAtoms);
  const nitroBonds = createNitrobenzeneSubsetMesh(bonds, 'nitro', includeNitroBonds);
  const remainderAtoms = createNitrobenzeneSubsetMesh(atoms, 'remainder', includeNitroAtoms);
  const remainderBonds = createNitrobenzeneSubsetMesh(bonds, 'remainder', includeNitroBonds);

  if (nitroAtoms) nitroGroup.add(nitroAtoms);
  if (nitroBonds) nitroGroup.add(nitroBonds);
  if (remainderAtoms) remainderGroup.add(remainderAtoms);
  if (remainderBonds) remainderGroup.add(remainderBonds);

  parent.add(remainderGroup);
  parent.add(nitroGroup);
  atoms.visible = false;
  bonds.visible = false;
  root.userData.grabbableParts = [nitroGroup, remainderGroup];

  return hasRenderableMesh(nitroGroup) ? [nitroGroup] : [];
};

const preparePubchem6233Model = (root: THREE.Object3D): GrabbablePart[] => {
  const atoms = root.getObjectByName('atoms') as THREE.Mesh | undefined;
  const bonds = root.getObjectByName('bonds') as THREE.Mesh | undefined;

  if (!atoms || !bonds || !isMeshObject(atoms) || !isMeshObject(bonds)) {
    return [];
  }

  const parent = atoms.parent ?? root;
  const groups: Record<PubchemPartKind, THREE.Group> = {
    'left-methyl': new THREE.Group(),
    'right-methyl': new THREE.Group(),
    core: new THREE.Group(),
  };

  groups['left-methyl'].name = 'PubChem 6233 left methyl';
  groups['right-methyl'].name = 'PubChem 6233 right methyl';
  groups.core.name = 'PubChem 6233 benzene core';
  groups['left-methyl'].userData.teachingRole = 'disassembly-part';
  groups['right-methyl'].userData.teachingRole = 'disassembly-part';
  groups.core.userData.disassemblable = false;

  (Object.keys(groups) as PubchemPartKind[]).forEach((partKind) => {
    const atomSubset = createPubchemSubsetMesh(atoms, partKind, classifyPubchemAtomTriangle, true);
    const bondSubset = createPubchemSubsetMesh(bonds, partKind, classifyPubchemBondTriangle, true);

    if (atomSubset) groups[partKind].add(atomSubset);
    if (bondSubset) groups[partKind].add(bondSubset);
    parent.add(groups[partKind]);
  });

  atoms.visible = false;
  bonds.visible = false;

  return [groups['left-methyl'], groups['right-methyl'], groups.core];
};

// 本次接入的 3 个解剖模型（心脏解剖 / 大脑 / 肺部）：
//  - 单向拆解：展开后不再归位（无复位）
//  - 复用心脏布局参数，与原有心脏拆解观感一致
export const ONE_WAY_ANATOMY_KEYS = ['organ-heart', 'organ-brain', 'organ-lungs'];

const isDisassemblablePart = (part: GrabbablePart): boolean => part.userData?.disassemblable !== false;

const getOriginalPosition = (part: GrabbablePart): THREE.Vector3 => {
  const original = part.userData.originalPosition;
  return original?.isVector3 ? original.clone() : part.position.clone();
};

const getManualTargetPosition = (part: GrabbablePart): THREE.Vector3 | null => {
  const manualTarget = part.userData.manualTargetPosition;
  return manualTarget?.isVector3 ? manualTarget.clone() : null;
};

const calculateDisassemblyTargets = (
  parts: GrabbablePart[],
  strength: number,
  spacing: number,
  layout: 'default' | 'heart' | 'earth' = 'default',
): Map<string, THREE.Vector3> => {
  const targets = new Map<string, THREE.Vector3>();
  const disassemblableParts = parts.filter(isDisassemblablePart);
  if (disassemblableParts.length === 0) return targets;

  const rootBox = new THREE.Box3();
  disassemblableParts.forEach((part) => rootBox.expandByObject(part));
  const rootCenter = rootBox.getCenter(new THREE.Vector3());
  const rootSize = rootBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(rootSize.x, rootSize.y, rootSize.z, 0.001);
  const placed: THREE.Vector3[] = [];

  // Detect concentric parts (e.g. earth layers) — all share the same center
  const origPositions = disassemblableParts.map(getOriginalPosition);
  const isConcentric = disassemblableParts.length > 1 && origPositions.every(
    (p) => p.distanceTo(origPositions[0]) < 0.01
  );

  // Only the earth model should use the wide concentric-shell layout. Some
  // GLB files (notably the heart) also keep every part at the same local
  // origin, but spreading those as concentric shells pushes them off-screen.
  const useWideConcentricLayout = layout === 'earth' && isConcentric;
  const spreadDistance = useWideConcentricLayout
    ? maxDim * 0.9
    : layout === 'heart'
    ? maxDim * (0.06 + Math.min(strength, 1) * 0.12)
    : maxDim * (0.15 + Math.min(strength, 1) * 0.25);
  const maxHeartOffset = maxDim * 0.17;

  disassemblableParts.forEach((part, index) => {
    const original = getOriginalPosition(part);
    const partBox = new THREE.Box3().setFromObject(part);
    const partCenter = partBox.getCenter(new THREE.Vector3());
    const angle = (index / Math.max(1, disassemblableParts.length)) * Math.PI * 2;
    const fallbackDirection = new THREE.Vector3(
      Math.cos(angle),
      ((index % 3) - 1) * 0.32,
      Math.sin(angle),
    ).normalize();

    const direction = partCenter.sub(rootCenter);
    if (direction.lengthSq() < 0.0001) {
      direction.copy(fallbackDirection);
      // Concentric layers (e.g. earth): spread horizontally only, same Y level
      if (useWideConcentricLayout) direction.y = 0;
      if (direction.lengthSq() > 0.001) direction.normalize();
    } else {
      direction.normalize();
      direction.addScaledVector(fallbackDirection, 0.35).normalize();
    }

    const target = original.clone().addScaledVector(direction, spreadDistance + index * spacing * 0.08);

    let guard = 0;
    while (placed.some((point) => point.distanceTo(target) < spacing) && guard < 10) {
      const adjustAngle = angle + guard * 0.77;
      target.add(new THREE.Vector3(Math.cos(adjustAngle), 0.18, Math.sin(adjustAngle)).multiplyScalar(spacing * 0.45));
      guard++;
    }

    if (layout === 'heart') {
      const offset = target.clone().sub(original);
      if (offset.length() > maxHeartOffset) {
        target.copy(original).add(offset.setLength(maxHeartOffset));
      }
    }

    placed.push(target.clone());
    targets.set(part.uuid, target);
  });

  return targets;
};

const createLocalLoadingManager = (assetUrls?: Record<string, string>) => {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((requestedUrl) => {
    return resolveAssetUrl(requestedUrl, assetUrls);
  });
  return manager;
};

const resolveAssetUrl = (requestedUrl: string, assetUrls?: Record<string, string>) => {
  if (!assetUrls || requestedUrl.startsWith('blob:') || requestedUrl.startsWith('data:')) {
    return requestedUrl;
  }

  const directUrl = assetUrls[requestedUrl] || assetUrls[requestedUrl.toLowerCase()];
  if (directUrl) return directUrl;

  const assetKey = getAssetKey(requestedUrl);
  return assetUrls[assetKey] || requestedUrl;
};

const isLikelyGitLfsPointer = (text: string) => text.startsWith('version https://git-lfs.github.com/spec/v1');

const MAX_SESSION_MODEL_TEMPLATES = 2;
type SessionModelTemplateEntry = {
  promise: Promise<THREE.Object3D>;
  refs: number;
  evicted: boolean;
  template: THREE.Object3D | null;
};

const sessionModelTemplates = new Map<string, SessionModelTemplateEntry>();
const sessionTemplateEntriesByRoot = new WeakMap<THREE.Object3D, SessionModelTemplateEntry>();
const validatedModelAssets = new Set<string>();

/**
 * Release a model instance without disposing geometry still owned by the
 * session template cache. Cloned materials are always local to the instance;
 * textures remain shared when the geometry came from a cached GLB.
 */
const disposeModelResources = (root: THREE.Object3D, sharedTemplateGeometry = false) => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();

  root.traverse((child) => {
    if (!isMeshObject(child)) return;
    const ownsGeometry = child.userData?.__ownedGeometry === true;
    if (!sharedTemplateGeometry || ownsGeometry) {
      if (child.geometry) geometries.add(child.geometry);
    }

    const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
    childMaterials.forEach((material) => {
      if (!material) return;
      materials.add(material);
      if (!sharedTemplateGeometry || material.userData?.__ownedTextures === true) {
        const materialWithTextures = material as THREE.Material & Record<string, unknown>;
        Object.keys(materialWithTextures).forEach((key) => {
          const value = materialWithTextures[key];
          if (value && typeof value === 'object' && (value as THREE.Texture).isTexture) {
            textures.add(value as THREE.Texture);
          }
        });
      }
    });
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
};

const disposeSessionTemplateEntry = (entry: SessionModelTemplateEntry) => {
  if (!entry.template) return;
  disposeModelResources(entry.template, false);
  entry.template = null;
};

const retainSessionTemplate = (template: THREE.Object3D) => {
  const entry = sessionTemplateEntriesByRoot.get(template);
  if (entry) entry.refs += 1;
  return entry;
};

const releaseSessionTemplate = (entry: SessionModelTemplateEntry | undefined) => {
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.evicted && entry.refs === 0) {
    disposeSessionTemplateEntry(entry);
  }
};

const isPublicBuiltInModel = (url: string, modelType: ModelType, assetUrls?: Record<string, string>) => {
  if (modelType !== 'glb' && modelType !== 'gltf') return false;
  if (assetUrls && Object.keys(assetUrls).length > 0) return false;

  try {
    const resolvedUrl = new URL(url, window.location.origin);
    return resolvedUrl.origin === window.location.origin && resolvedUrl.pathname.startsWith('/models/');
  } catch {
    return false;
  }
};

const cloneModelTemplate = (template: THREE.Object3D) => {
  const clone = cloneSkinnedModel(template);
  const templateEntry = retainSessionTemplate(template);
  clone.userData.__sharedTemplateGeometry = true;
  if (templateEntry) clone.userData.__sessionTemplateEntry = templateEntry;

  // Interaction and highlighting mutate materials, so template and live model stay independent.
  clone.traverse((child) => {
    if (!isMeshObject(child)) return;
    child.material = Array.isArray(child.material)
      ? child.material.map((material) => material.clone())
      : child.material.clone();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      material.userData.__ownedTextures = false;
    });
  });

  return clone;
};

const loadSessionModelTemplate = (
  url: string,
  loadingManager: THREE.LoadingManager,
  onProgress?: (event: ProgressEvent) => void,
) => {
  const cachedEntry = sessionModelTemplates.get(url);
  if (cachedEntry) {
    // Reinsert to keep the map in least-recently-used order.
    sessionModelTemplates.delete(url);
    sessionModelTemplates.set(url, cachedEntry);
    return cachedEntry.promise;
  }

  let entry: SessionModelTemplateEntry;
  const templatePromise = new Promise<THREE.Object3D>((resolve, reject) => {
    const loader = new GLTFLoader(loadingManager);
    loader.setMeshoptDecoder(MeshoptDecoder);
    const dracoLoader = new DRACOLoader(loadingManager);
    dracoLoader.setDecoderPath('/draco/');
    dracoLoader.setDecoderConfig({ type: 'wasm' });
    loader.setDRACOLoader(dracoLoader);

    loader.load(
      url,
      (gltf) => {
        dracoLoader.dispose();
        entry.template = gltf.scene;
        sessionTemplateEntriesByRoot.set(gltf.scene, entry);
        resolve(gltf.scene);
      },
      onProgress,
      (error) => {
        dracoLoader.dispose();
        reject(error);
      },
    );
  });
  entry = { promise: templatePromise, refs: 0, evicted: false, template: null };

  sessionModelTemplates.set(url, entry);
  while (sessionModelTemplates.size > MAX_SESSION_MODEL_TEMPLATES) {
    const oldestUrl = sessionModelTemplates.keys().next().value;
    if (!oldestUrl) break;
    const oldestEntry = sessionModelTemplates.get(oldestUrl);
    sessionModelTemplates.delete(oldestUrl);
    if (oldestEntry) {
      oldestEntry.evicted = true;
      if (oldestEntry.refs === 0) {
        oldestEntry.promise.then(() => {
          // Let any await continuation clone the just-loaded template before
          // reclaiming an evicted entry that was never retained.
          setTimeout(() => {
            if (oldestEntry.refs === 0) disposeSessionTemplateEntry(oldestEntry);
          }, 0);
        }).catch(() => undefined);
      }
    }
  }

  templatePromise.catch(() => {
    if (sessionModelTemplates.get(url) === entry) {
      sessionModelTemplates.delete(url);
    }
  });

  return templatePromise;
};

const getModelLoadError = (error: unknown): ModelLoadError => {
  const rawMessage = error instanceof Error ? error.message : String(error || '');
  const message = rawMessage || '未知加载错误';

  if (message.includes('git-lfs.github.com/spec/v1') || message.includes('Git LFS')) {
    return {
      title: '模型资源未完整下载',
      detail: '当前 .glb 文件是 Git LFS 指针文件，请同步 Git LFS 后再打开模型。',
    };
  }

  return {
    title: '模型加载失败',
    detail: message,
  };
};

const assertModelAssetReady = async (requestedUrl: string, assetUrls?: Record<string, string>) => {
  const resolvedUrl = resolveAssetUrl(requestedUrl, assetUrls);
  if (resolvedUrl.startsWith('data:') || validatedModelAssets.has(resolvedUrl)) return;

  const response = await fetch(resolvedUrl, {
    headers: { Range: 'bytes=0-255' },
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`无法读取模型资源：HTTP ${response.status}`);
  }

  const reader = response.body?.getReader();
  const firstChunk = reader ? await reader.read() : { value: undefined };
  await reader?.cancel();
  const text = firstChunk.value ? new TextDecoder().decode(firstChunk.value) : '';
  if (isLikelyGitLfsPointer(text)) {
    throw new Error('Git LFS pointer detected: version https://git-lfs.github.com/spec/v1');
  }

  validatedModelAssets.add(resolvedUrl);
};

const earthLayerMeta = [
  { key: 'crust', title: '地壳 Crust', detail: '5-70 km · 固态岩石圈', color: '#2f8f5b' },
  { key: 'mantle', title: '地幔 Mantle', detail: '~2900 km · 高温固态', color: '#e85a24' },
  { key: 'outercore', title: '外核 Outer Core', detail: '~2200 km · 液态金属', color: '#f5a623' },
  { key: 'innercore', title: '内核 Inner Core', detail: '~1220 km · 固态铁镍', color: '#f6d84a' },
] as const;

const EARTH_LAYER_LABEL_REVEAL_DISTANCE = 0.12;

const getEarthLayerMeta = (part: GrabbablePart, index: number) => {
  const normalizedName = part.name.toLowerCase().replace(/[^a-z]/g, '');
  return earthLayerMeta.find((meta) => normalizedName.includes(meta.key)) || earthLayerMeta[index % earthLayerMeta.length];
};

const EarthLayerFollowLabels: React.FC<{
  parts: GrabbablePart[];
  rootGroupRef: React.RefObject<THREE.Group>;
  controlRef: React.MutableRefObject<ControlRefs>;
  enabled: boolean;
}> = ({ parts, rootGroupRef, controlRef, enabled }) => {
  const labelRefs = useRef<THREE.Group[]>([]);
  const [visibleLayerCount, setVisibleLayerCount] = useState(0);
  const visibleLayerCountRef = useRef(0);
  const cachedSizesRef = useRef<number[]>([]);

  // 预先计算包围盒大小，避免在每一帧中重复遍历网格顶点计算 Box3
  useEffect(() => {
    if (parts.length === 0) return;
    cachedSizesRef.current = parts.map((part) => {
      const box = new THREE.Box3().setFromObject(part);
      const size = box.getSize(new THREE.Vector3());
      return size.y;
    });
  }, [parts]);

  const updateVisibleLayerCount = (nextCount: number) => {
    if (visibleLayerCountRef.current === nextCount) return;
    visibleLayerCountRef.current = nextCount;
    setVisibleLayerCount(nextCount);
  };

  useFrame(() => {
    if (!enabled || !rootGroupRef.current || parts.length === 0) {
      labelRefs.current.forEach((label) => { if (label) label.visible = false; });
      updateVisibleLayerCount(0);
      return;
    }

    const maxLayers = Math.min(parts.length, 4);

    // 计算展开的层数 (每帧执行，只涉及 4 次 Vector3 距离计算，性能开销极低)
    let revealedCount = 1;
    for (let i = 0; i < maxLayers - 1; i++) {
      const distanceFromOriginal = parts[i].position.distanceTo(getOriginalPosition(parts[i]));
      if (distanceFromOriginal > EARTH_LAYER_LABEL_REVEAL_DISTANCE) {
        revealedCount = i + 2;
      } else {
        break;
      }
    }
    updateVisibleLayerCount(revealedCount);

    // 每帧更新标签位置 (移除 80ms 节流限制，实现 60fps 丝滑跟随动效)
    parts.slice(0, maxLayers).forEach((part, index) => {
      const label = labelRefs.current[index];
      if (!label) return;

      if (index >= revealedCount) {
        label.visible = false;
        return;
      }

      // 直接获取部件的世界坐标 (不再遍历网格计算包围盒中心，改用 precomputed size.y)
      const worldPosition = new THREE.Vector3();
      part.getWorldPosition(worldPosition);

      const sizeY = cachedSizesRef.current[index] || 1.0;
      worldPosition.y += Math.max(0.35, sizeY * 0.58);
      
      const localPosition = rootGroupRef.current!.worldToLocal(worldPosition);
      label.position.lerp(localPosition, 0.18);
      label.visible = true;
    });
  });

  if (!enabled || parts.length === 0) return null;

  return (
    <>
      {parts.slice(0, 4).map((part, index) => {
        const meta = getEarthLayerMeta(part, index);
        return (
          <group
            key={part.uuid}
            visible={false}
            ref={(node: THREE.Group | null) => {
              if (node) labelRefs.current[index] = node;
            }}
          >
            {index < visibleLayerCount && (
              <Html distanceFactor={10} center>
                <div className="bg-white/95 backdrop-blur-md px-3 py-2 rounded-xl text-slate-800 text-[10px] whitespace-nowrap border shadow-lg font-bold" style={{ borderColor: meta.color }}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: meta.color }} />
                    <span style={{ color: meta.color }} className="text-[11px] font-extrabold">{meta.title}</span>
                  </div>
                  <div className="font-medium text-slate-500 leading-relaxed text-[9px]">{meta.detail}</div>
                </div>
              </Html>
            )}
          </group>
        );
      })}
    </>
  );
};

const LocalEnvironment: React.FC = () => {
  const { gl, scene } = useThree();

  useEffect(() => {
    const pmremGenerator = new THREE.PMREMGenerator(gl);
    const environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
    const previousEnvironment = scene.environment;

    scene.environment = environment;

    return () => {
      scene.environment = previousEnvironment;
      environment.dispose();
      pmremGenerator.dispose();
    };
  }, [gl, scene]);

  return null;
};

// Unified model component. FBX / GLB / GLTF all use the same layer-based disassembly path.
const LayeredModel: React.FC<{ url: string; modelType: ModelType; assetUrls?: Record<string, string>; controlRef: React.MutableRefObject<ControlRefs>; cameraTarget: CameraTarget; showEarthLabels?: boolean; accent?: string; onLoadProgress?: (progress: LoadProgress) => void; onLoadComplete?: () => void; onLoadError?: (error: ModelLoadError) => void; onPartMoved?: (partName: string) => void; onDisassemblyAvailabilityChange?: (available: boolean) => void }> = ({ url, modelType, assetUrls, controlRef, cameraTarget, showEarthLabels = false, accent = '#86e3ce', onLoadProgress, onLoadComplete, onLoadError, onPartMoved, onDisassemblyAvailabilityChange }) => {
  const [modelScene, setModelScene] = useState<THREE.Object3D | null>(null);
  const [modelParts, setModelParts] = useState<GrabbablePart[]>([]);
  const [grabbableParts, setGrabbableParts] = useState<GrabbablePart[]>([]);
  const groupRef = useRef<THREE.Group>(null);
  const { camera, raycaster, scene } = useThree();
  const orbitControls = useThree((threeState) => (threeState as any).controls as {
    enabled?: boolean;
    target?: THREE.Vector3;
    update?: () => void;
  } | undefined);
  const orbitTarget = useMemo(() => vectorFromTarget(cameraTarget), [cameraTarget]);

  // ========== 一比一复刻第一版变量 ==========
  const isGrabbingRef = useRef(false);
  const grabbedPartRef = useRef<GrabbablePart | null>(null);
  const grabbedParentRef = useRef<THREE.Object3D | null>(null);
  const grabStartPositionRef = useRef(new THREE.Vector3());
  const grabMovedRef = useRef(false);
  const grabOffsetRef = useRef(new THREE.Vector3());
  const dragPlaneRef = useRef(new THREE.Plane());
  const dragTargetPositionRef = useRef(new THREE.Vector3());
  const dragGestureSessionRef = useRef(createDragGestureSessionState(controlRef.current.isDragging));
  const raycastTargetsRef = useRef<THREE.Object3D[]>([]);
  const meshToPartRef = useRef<WeakMap<THREE.Object3D, GrabbablePart>>(new WeakMap());
  const highlightMaterialsRef = useRef<WeakMap<GrabbablePart, HighlightMaterial[]>>(new WeakMap());
  const dragPickProxiesRef = useRef<DragPickProxy[]>([]);

  // 手部状态 (一比一复刻第一版 handsState)
  const interactionHandStateRef = useRef<{
    exists: boolean;
    isFist: boolean;
    isOpen: boolean;
    ndc: THREE.Vector2 | null;
  }>({
    exists: false,
    isFist: false,
    isOpen: false,
    ndc: null
  });

  // 虚拟平面 (用于手部3D投影)
  const handProjectionScratchRef = useRef({
    cameraDir: new THREE.Vector3(),
    rayDir: new THREE.Vector3(),
    points: Array.from({ length: 21 }, () => new THREE.Vector3()),
    offset: new THREE.Vector3(),
    worldPos: new THREE.Vector3(),
    worldQuat: new THREE.Quaternion(),
    worldScale: new THREE.Vector3(),
    intersectPoint: new THREE.Vector3(),
    targetPoint: new THREE.Vector3(),
    targetLocal: new THREE.Vector3(),
    pickPoint: new THREE.Vector3()
  });

  // Persistent spherical coords for smooth camera orbit (avoids zoom+rotation conflict)
  const sphericalRef = useRef(new THREE.Spherical());
  const cameraInitialized = useRef(false);
  const wasCameraGestureActiveRef = useRef(false);
  const disassemblyTargetsRef = useRef<Map<string, THREE.Vector3>>(new Map());
  const lastDisassemblyActionRef = useRef(-1);
  // 解剖模型单向拆解：一旦展开就锁存，收到复位指令也不归还部件
  const oneWayLatchRef = useRef(false);
  // Load model and detect whether the file contains detachable internal layers.
  useEffect(() => {
    let disposed = false;
    let loadedRoot: THREE.Object3D | null = null;
    let loadedParts: GrabbablePart[] = [];
    let loadedTemplateEntry: SessionModelTemplateEntry | undefined;
    let dracoLoader: DRACOLoader | null = null;
    const loadingManager = createLocalLoadingManager(assetUrls);

    setModelScene(null);
    setModelParts([]);
    setGrabbableParts([]);
    grabbedPartRef.current = null;
    grabbedParentRef.current = null;
    isGrabbingRef.current = false;
    grabMovedRef.current = false;
    dragGestureSessionRef.current = createDragGestureSessionState(controlRef.current.isDragging);
    raycastTargetsRef.current = [];
    meshToPartRef.current = new WeakMap();
    highlightMaterialsRef.current = new WeakMap();
    dragPickProxiesRef.current = [];
    cameraInitialized.current = false;
    wasCameraGestureActiveRef.current = false;
    disassemblyTargetsRef.current.clear();
    lastDisassemblyActionRef.current = -1;
    oneWayLatchRef.current = false;

    const handleLoadedModel = (root: THREE.Object3D) => {
      if (disposed) return;

      const lowerUrl = url.toLowerCase();
      const isEarthLayers = lowerUrl.includes('earth-layers');
      const isEarthPolitical = lowerUrl.includes('earth-political') || lowerUrl.includes('earth_political');
      let targetSize = MODEL_TARGET_SIZE;
      if (isEarthLayers) targetSize = EARTH_LAYERS_TARGET_SIZE;
      else if (isEarthPolitical) targetSize = EARTH_POLITICAL_TARGET_SIZE;
      if (!hasRenderableMesh(root)) {
        throw new Error('模型文件已读取，但没有发现可渲染的网格对象。');
      }
      configureModel(root, targetSize);

      if (isDiamondModel(url)) {
        enhanceDiamondModel(root);
      }

      const customParts = isNitrobenzeneModel(url)
        ? prepareNitrobenzeneModel(root)
        : isPubchem6233Model(url)
          ? preparePubchem6233Model(root)
          : [];
      const parts = isDiamondModel(url) || isDiamondUnitCellModel(url)
        ? []
        : customParts.length > 0
          ? customParts
          : findLayerRoots(root);
      const candidateInteractionParts = Array.isArray(root.userData.grabbableParts)
        ? root.userData.grabbableParts as GrabbablePart[]
        : parts;
      const interactionParts = candidateInteractionParts.filter(isDisassemblablePart);

      Array.from(new Set([...parts, ...interactionParts])).forEach((part) => {
        part.userData.originalPosition = part.position.clone();
      });

      const nextMeshToPart = new WeakMap<THREE.Object3D, GrabbablePart>();
      const nextHighlightMaterials = new WeakMap<GrabbablePart, HighlightMaterial[]>();
      const nextRaycastTargets: THREE.Object3D[] = [];
      const nextDragPickProxies: DragPickProxy[] = [];

      interactionParts.forEach((part) => {
        const meshes = collectMeshes(part);
        meshes.forEach((mesh) => {
          nextMeshToPart.set(mesh, part);
          nextRaycastTargets.push(mesh);
        });
        nextHighlightMaterials.set(part, collectHighlightMaterials(part));
        const pickProxy = createDragPickProxy(part);
        if (pickProxy) {
          nextDragPickProxies.push(pickProxy);
        }
      });

      raycastTargetsRef.current = nextRaycastTargets;
      meshToPartRef.current = nextMeshToPart;
      highlightMaterialsRef.current = nextHighlightMaterials;
      dragPickProxiesRef.current = nextDragPickProxies;

      loadedRoot = root;
      loadedTemplateEntry = root.userData.__sessionTemplateEntry as SessionModelTemplateEntry | undefined;
      loadedParts = interactionParts;
      setModelParts(parts);
      setGrabbableParts(interactionParts);
      setModelScene(root);
      onDisassemblyAvailabilityChange?.(parts.length > 1);

      const format = modelType.toUpperCase();
      const message = parts.length > 0
        ? `${format}加载完成，检测到 ${parts.length} 个可拆解层级`
        : `${format}加载完成，当前模型没有可拆解层级`;
      console.log(message);
    };

    const handleLoadError = (error: unknown) => {
      if (disposed) return;
      const loadError = getModelLoadError(error);
      console.error('模型加载失败:', error);
      onLoadError?.(loadError);
    };

    const handleProgress = (event: ProgressEvent) => {
      if (onLoadProgress && event.total > 0) {
        onLoadProgress({
          loaded: event.loaded,
          total: event.total,
          percent: Math.round((event.loaded / event.total) * 100),
        });
      }
    };

    const handleLoadedModelAndNotify = (root: THREE.Object3D) => {
      if (disposed) {
        const sharedTemplateGeometry = root.userData.__sharedTemplateGeometry === true;
        disposeModelResources(root, sharedTemplateGeometry);
        releaseSessionTemplate(root.userData.__sessionTemplateEntry as SessionModelTemplateEntry | undefined);
        return;
      }
      try {
        handleLoadedModel(root);
        onLoadComplete?.();
      } catch (error) {
        const sharedTemplateGeometry = root.userData.__sharedTemplateGeometry === true;
        disposeModelResources(root, sharedTemplateGeometry);
        releaseSessionTemplate(root.userData.__sessionTemplateEntry as SessionModelTemplateEntry | undefined);
        handleLoadError(error);
      }
    };

    const loadModel = async () => {
      try {
        await assertModelAssetReady(url, assetUrls);
        if (disposed) return;

        if (isPublicBuiltInModel(url, modelType, assetUrls)) {
          const template = await loadSessionModelTemplate(url, loadingManager, handleProgress);
          if (disposed) return;
          handleLoadedModelAndNotify(cloneModelTemplate(template));
        } else if (modelType === 'fbx') {
          const loader = new FBXLoader(loadingManager);
          loader.load(url, handleLoadedModelAndNotify, handleProgress, handleLoadError);
        } else {
          const loader = new GLTFLoader(loadingManager);
          loader.setMeshoptDecoder(MeshoptDecoder);
          dracoLoader = new DRACOLoader(loadingManager);
          dracoLoader.setDecoderPath('/draco/');
          dracoLoader.setDecoderConfig({ type: 'wasm' });
          loader.setDRACOLoader(dracoLoader);
          loader.load(url, (gltf) => handleLoadedModelAndNotify(gltf.scene), handleProgress, handleLoadError);
        }
      } catch (error) {
        handleLoadError(error);
      }
    };

    loadModel();

    return () => {
      disposed = true;
      dracoLoader?.dispose();
      loadedParts.forEach((part) => {
        if (part.parent === scene) {
          scene.remove(part);
        }
      });
      if (loadedRoot) {
        const sharedTemplateGeometry = loadedRoot.userData.__sharedTemplateGeometry === true;
        disposeModelResources(loadedRoot, sharedTemplateGeometry);
        releaseSessionTemplate(loadedTemplateEntry);
      }
    };
  }, [assetUrls, modelType, onLoadError, scene, url]);

  // 更新手部状态 (一比一复刻第一版 updateHandState)
  const updateHandState = (
    landmarks: { x: number; y: number; z: number }[],
    filteredNdc?: { x: number; y: number } | null,
  ) => {
    const state = interactionHandStateRef.current;
    state.exists = true;
    const scratch = handProjectionScratchRef.current;

    // 更新虚拟平面
    const planeDistance = 2;
    camera.getWorldDirection(scratch.cameraDir);

    // 将landmarks投影到3D世界坐标
    const project3D = (lmk: { x: number; y: number; z: number }, point: THREE.Vector3) => {
      const ndcX = (0.5 - lmk.x) * 2;
      const ndcY = -(lmk.y - 0.5) * 2;
      point.set(ndcX, ndcY, 0.5).unproject(camera);
      scratch.rayDir.copy(point).sub(camera.position).normalize();
      const planeHitDistance = planeDistance / Math.max(0.0001, scratch.rayDir.dot(scratch.cameraDir));
      point.copy(camera.position).addScaledVector(scratch.rayDir, planeHitDistance);
    };
    for (let i = 0; i < 21; i += 1) {
      project3D(landmarks[i], scratch.points[i]);
    }

    const wrist = scratch.points[0];
    const middleMCP = scratch.points[9];
    const handScale = wrist.distanceTo(middleMCP);

    // 计算指尖到腕关节的平均距离
    const tipIndices = [4, 8, 12, 16, 20];
    let totalDist = 0;
    tipIndices.forEach(i => {
      totalDist += scratch.points[i].distanceTo(wrist);
    });
    const avgDist = totalDist / 5;

    // 归一化距离 (一比一复刻第一版阈值)
    const normalizedDist = handScale > 0 ? avgDist / handScale : 0;
    state.isFist = normalizedDist < 1.2;
    state.isOpen = normalizedDist > 1.8;

    // HandController owns pinch hysteresis; the viewer only consumes its
    // canonical drag signal so release and reacquisition cannot disagree.
    if (controlRef.current.isDragging) {
      state.isOpen = false;
    }

    // 计算NDC (一比一复刻平滑滤波)
    const avgX = (landmarks[4].x + landmarks[8].x) / 2;
    const avgY = (landmarks[4].y + landmarks[8].y) / 2;
    const targetNdcX = (0.5 - avgX) * 2;
    const targetNdcY = -(avgY - 0.5) * 2;

    // HandController already applies the single time-aware position filter.
    // Consume that filtered sample directly here; another per-render EMA made
    // dragging lag behind the visible hand by several frames.  Keep the raw
    // landmarks for gesture shape/pinch classification, but never rebuild the
    // drag ray from their unfiltered thumb/index center.
    const filteredTargetNdc = filteredNdc
      && Number.isFinite(filteredNdc.x)
      && Number.isFinite(filteredNdc.y)
      ? filteredNdc
      : null;
    if (!state.ndc) state.ndc = new THREE.Vector2();
    state.ndc.set(
      filteredTargetNdc?.x ?? targetNdcX,
      filteredTargetNdc?.y ?? targetNdcY,
    );

  };

  // 释放零件 (一比一复刻第一版 releaseGrab)
  const releaseGrab = () => {
    const part = grabbedPartRef.current;
    const didMove = Boolean(
      part
      && grabMovedRef.current
      && part.position.distanceTo(grabStartPositionRef.current) >= PART_MOVE_LOG_THRESHOLD,
    );
    const partName = part ? getReadablePartLabel(part) : null;
    if (part) {
      part.userData.manualTargetPosition = part.position.clone();
      const highlightMaterials = highlightMaterialsRef.current.get(part);
      if (highlightMaterials) {
        highlightMaterials.forEach((material) => material.emissive?.setHex(0x000000));
      } else {
        setPartHighlight(part, 0x000000);
      }
    }

    if (didMove && partName) onPartMoved?.(partName);

    isGrabbingRef.current = false;
    grabbedPartRef.current = null;
    grabbedParentRef.current = null;
    grabMovedRef.current = false;
  };

  const pickGrabbablePart = (): GrabbablePart | null => {
    const proxies = dragPickProxiesRef.current;
    const scratch = handProjectionScratchRef.current;
    const raycastTargets = raycastTargetsRef.current;
    groupRef.current?.updateWorldMatrix(true, true);
    const preciseHits = raycaster.intersectObjects(
      raycastTargets.length > 0 ? raycastTargets : grabbableParts,
      raycastTargets.length === 0,
    ).flatMap((intersection) => {
      const part = meshToPartRef.current.get(intersection.object)
        || grabbableParts.find((candidate) => isDescendantOf(intersection.object, candidate));
      return part ? [{ part, distanceSq: intersection.distance * intersection.distance }] : [];
    });
    const proxyHits: Array<{ part: GrabbablePart; distanceSq: number }> = [];

    if (proxies.length > 0) {
      proxies.forEach((proxy) => {
        proxy.worldBox.copy(proxy.localBox).applyMatrix4(proxy.part.matrixWorld);
        const hitPoint = raycaster.ray.intersectBox(proxy.worldBox, scratch.pickPoint);
        if (!hitPoint) return;
        proxyHits.push({
          part: proxy.part,
          distanceSq: raycaster.ray.origin.distanceToSquared(hitPoint),
        });
      });
    }
    return selectDragPickCandidate(preciseHits, proxyHits);
  };

  useFrame((state, delta) => {
    const frameStartedAt = performance.now();
    const finishFrame = () => {
      const frameEndedAt = performance.now();
      const callbackMs = frameEndedAt - frameStartedAt;
      performanceTelemetry.recordRendererInfo(state.gl.info);
      performanceTelemetry.recordFrame(
        Math.max(0, delta * 1000),
        frameEndedAt,
        { delta, dpr: state.gl.getPixelRatio?.() ?? 1, callbackMs },
      );
    };

    if (!modelScene || !groupRef.current) {
      finishFrame();
      return;
    }

    const {
      rotationVelocity,
      rotationGestureActive,
      rotationLocked,
      zoomSpeed,
      isDragging: pinchGestureActive,
      interactionHandLandmarks,
      handNDCPosition,
    } = controlRef.current;
    // HandController publishes time-normalized rates and performs the single
    // input low-pass. Do not smooth/integrate the same sample a second time.
    const suppressGestureRotation = rotationLocked
      || (isGrabbingRef.current && !controlRef.current.voiceRotationActive);
    const smoothRotX = suppressGestureRotation ? 0 : rotationVelocity.x;
    const smoothRotY = suppressGestureRotation ? 0 : rotationVelocity.y;
    const smoothZoom = zoomSpeed;
    consumePublishedHandInput(controlRef.current, frameStartedAt);
    // rotationVelocity/zoomSpeed are time-normalized rates (per second).
    // Integrate them once with the actual frame delta; multiplying by 60 here
    // would amplify input on top of the producer's rate conversion.
    const frameDelta = Math.min(delta, 0.05);

    const hasRotationGestureInput =
      Math.abs(smoothRotX) > 0.0001 ||
      Math.abs(smoothRotY) > 0.0001;
    const hasActiveRotationGesture = !rotationLocked && rotationGestureActive;
    const hasCameraGestureInput =
      hasRotationGestureInput ||
      Math.abs(smoothZoom) > 0.0001;

    const scratch = handProjectionScratchRef.current;
    const offset = scratch.offset.subVectors(camera.position, orbitTarget);
    if (!cameraInitialized.current || !wasCameraGestureActiveRef.current) {
      sphericalRef.current.setFromVector3(offset);
      cameraInitialized.current = true;
    }

    const sph = sphericalRef.current;

    // 旋转 — modify angles on persistent spherical (uses smoothed velocity)
    if (hasCameraGestureInput && (Math.abs(smoothRotX) > 0.0001 || Math.abs(smoothRotY) > 0.0001)) {
      const sensitivity = 0.31 * (controlRef.current.interactionSettings?.rotationSpeed ?? 5.0);
      sph.theta -= smoothRotY * sensitivity * frameDelta;
      sph.phi -= smoothRotX * sensitivity * frameDelta;
      sph.phi = Math.max(0.1, Math.min(Math.PI - 0.1, sph.phi));
      sph.makeSafe();
    }

    // 缩放 — modify radius on persistent spherical (no conflict with rotation)
    if (hasCameraGestureInput && Math.abs(smoothZoom) > 0.0001) {
      sph.radius = Math.max(
        3,
        Math.min(12, sph.radius - smoothZoom * 0.13 * frameDelta * (controlRef.current.interactionSettings?.zoomSpeed ?? 1.0))
      );
    }

    // Apply spherical to camera
    if (hasCameraGestureInput) {
      if (orbitControls) {
        orbitControls.enabled = false;
      }
      camera.position.setFromSpherical(sph).add(orbitTarget);
      camera.lookAt(orbitTarget);
    } else {
      sphericalRef.current.setFromVector3(offset);
      if (wasCameraGestureActiveRef.current) {
        if (orbitControls?.target) {
          orbitControls.target.copy(orbitTarget);
          orbitControls.update?.();
        }
        if (orbitControls) {
          orbitControls.enabled = true;
        }
      }
    }
    wasCameraGestureActiveRef.current = hasCameraGestureInput;

    const disassembly = controlRef.current.agentDisassembly;
    if (disassembly && disassembly.actionId !== lastDisassemblyActionRef.current) {
      grabbableParts.forEach((part) => {
        delete part.userData.manualTargetPosition;
      });
      const isOneWayAnatomy = ONE_WAY_ANATOMY_KEYS.some((key) => url.toLowerCase().includes(key));
      if (disassembly.enabled) {
        disassemblyTargetsRef.current = calculateDisassemblyTargets(
          modelParts,
          disassembly.strength,
          disassembly.spacing,
          url.toLowerCase().includes('earth-layers')
            ? 'earth'
            : /heart|organ-brain|organ-lungs/.test(url.toLowerCase())
              ? 'heart'
              : 'default',
        );
        // 解剖模型：锁存，后续复位指令不再生效
        if (isOneWayAnatomy) oneWayLatchRef.current = true;
      } else if (!(isOneWayAnatomy && oneWayLatchRef.current)) {
        // 其余模型保持原有复位逻辑
        disassemblyTargetsRef.current = new Map();
      }
      lastDisassemblyActionRef.current = disassembly.actionId;
    }

    if (modelParts.length > 0 && !isGrabbingRef.current) {
      const isOneWayAnatomy = ONE_WAY_ANATOMY_KEYS.some((key) => url.toLowerCase().includes(key));
      // 单向拆解模型锁存后即使收到 enabled=false 也保持展开状态
      const disassemblyActive = Boolean(disassembly?.enabled) || (isOneWayAnatomy && oneWayLatchRef.current);
      modelParts.forEach((part) => {
        if (part === grabbedPartRef.current) return;
        const manualTarget = getManualTargetPosition(part);
        const target = manualTarget ?? (disassemblyActive
          ? disassemblyTargetsRef.current.get(part.uuid) || getOriginalPosition(part)
          : getOriginalPosition(part));
        part.position.lerp(target, disassemblyActive ? 0.075 : 0.09);
      });
    }

    // ========== 一比一复刻第一版手部交互 ==========
    const activeInteractionLandmarks = interactionHandLandmarks;
    const handState = interactionHandStateRef.current;
    const handVisible = Boolean(activeInteractionLandmarks && activeInteractionLandmarks.length >= 21);

    if (handVisible && activeInteractionLandmarks) {
      updateHandState(activeInteractionLandmarks, handNDCPosition);
    } else {
      handState.exists = false;
    }

    const dragSession = advanceDragGestureSession(dragGestureSessionRef.current, {
      handVisible,
      pinchActive: pinchGestureActive,
      rotationActive: hasActiveRotationGesture,
    });
    dragGestureSessionRef.current = dragSession.state;
    if (dragSession.shouldRelease && isGrabbingRef.current) {
      releaseGrab();
    }

    if (dragSession.shouldAttemptSelection && !isGrabbingRef.current && handState.ndc && grabbableParts.length > 0) {
        raycaster.setFromCamera(handState.ndc, camera);
        const hitPart = pickGrabbablePart();

        if (hitPart) {
          if (!controlRef.current.voiceRotationActive) {
            controlRef.current.rotationVelocity.x = 0;
            controlRef.current.rotationVelocity.y = 0;
          }
          isGrabbingRef.current = true;
          grabbedPartRef.current = hitPart;
          grabbedParentRef.current = hitPart.parent;
          grabStartPositionRef.current.copy(hitPart.position);
          grabMovedRef.current = false;

          // 获取世界坐标
          const { worldPos } = scratch;
          hitPart.getWorldPosition(worldPos);

          // 高亮
          const highlightMaterials = highlightMaterialsRef.current.get(hitPart);
          if (highlightMaterials) {
            highlightMaterials.forEach((material) => material.emissive?.setHex(0x333333));
          } else {
            setPartHighlight(hitPart, 0x333333);
          }

          // 设置拖拽平面
          dragPlaneRef.current.setFromNormalAndCoplanarPoint(
            camera.getWorldDirection(scratch.cameraDir),
            worldPos
          );

          // 计算偏移
          raycaster.ray.intersectPlane(dragPlaneRef.current, scratch.intersectPoint);
          grabOffsetRef.current.copy(worldPos).sub(scratch.intersectPoint);
          dragTargetPositionRef.current.copy(worldPos);
        }
    }

    if (
      handVisible
      && pinchGestureActive
      && !hasActiveRotationGesture
      && isGrabbingRef.current
      && grabbedPartRef.current
      && handState.ndc
    ) {
      raycaster.setFromCamera(handState.ndc, camera);
      if (raycaster.ray.intersectPlane(dragPlaneRef.current, scratch.targetPoint)) {
        dragTargetPositionRef.current.copy(scratch.targetPoint).add(grabOffsetRef.current);
        const parent = grabbedParentRef.current || scene;
        scratch.targetLocal.copy(dragTargetPositionRef.current);
        parent.worldToLocal(scratch.targetLocal);
        grabbedPartRef.current.position.copy(scratch.targetLocal);
        if (grabbedPartRef.current.position.distanceTo(grabStartPositionRef.current) >= PART_MOVE_LOG_THRESHOLD) {
          grabMovedRef.current = true;
        }
      }
    }

    // 待机动画 — 关闭默认自转，模型静止展示，只响应语音/手势指令
    // if (!rotationLocked && !hasCameraGestureInput && !isGrabbingRef.current) {
    //   groupRef.current.rotation.y += Math.sin(state.clock.elapsedTime * 0.3) * 0.001 * frameScale;
    // }
    finishFrame();
  }, -1);

  if (!modelScene) {
    return (
      <group>
        <mesh position={[0, 0, 0]}>
          <sphereGeometry args={[0.5, 16, 16]} />
          <meshStandardMaterial color={accent} wireframe />
        </mesh>
      </group>
    );
  }

  return (
    <group ref={groupRef} position={[0, 0, 0]}>
      <primitive object={modelScene} />
      <EarthLayerFollowLabels parts={modelParts} rootGroupRef={groupRef} controlRef={controlRef} enabled={showEarthLabels} />
    </group>
  );
};

/* ── Workbench — clean minimalist work surface ── */
const Workbench: React.FC = () => {
  return (
    <group position={[0, 0, 0]}>
      {/* Table top */}
      <mesh position={[0, 0, 0]} receiveShadow castShadow>
        <boxGeometry args={[4, 0.06, 3]} />
        <meshStandardMaterial
          color="#f5f0eb"
          roughness={0.55}
          metalness={0.0}
          envMapIntensity={0.3}
        />
      </mesh>
      {/* Table legs — slim round */}
      {([[-1.7, -0.25, -1.2], [1.7, -0.25, -1.2], [-1.7, -0.25, 1.2], [1.7, -0.25, 1.2]] as [number, number, number][]).map((pos, i) => (
        <mesh key={i} position={pos} castShadow>
          <cylinderGeometry args={[0.03, 0.03, 0.5, 16]} />
          <meshStandardMaterial color="#e8e4e0" roughness={0.6} metalness={0.0} />
        </mesh>
      ))}
    </group>
  );
};

const EarthLayerLabels: React.FC<{ visible: boolean }> = ({ visible }) => {
  if (!visible) return null;

  const labels = [
    { title: '地壳 Crust', detail: '5-70 km · 固态岩石圈', color: '#2f8f5b', position: [2.95, 2.55, 0] },
    { title: '地幔 Mantle', detail: '~2900 km · 高温固态', color: '#e85a24', position: [3.05, 1.55, 0] },
    { title: '外核 Outer Core', detail: '~2200 km · 液态金属', color: '#f5a623', position: [3.05, 0.55, 0] },
    { title: '内核 Inner Core', detail: '~1220 km · 固态铁镍', color: '#f6d84a', position: [2.95, -0.45, 0] },
  ] as const;

  return (
    <group position={[0, 0.2, 0]}>
      {labels.map((label) => (
        <Html key={label.title} distanceFactor={10} position={label.position as unknown as [number, number, number]} center>
          <div className="bg-white/95 backdrop-blur-md px-3 py-2 rounded-xl text-slate-800 text-[10px] whitespace-nowrap border shadow-lg font-bold" style={{ borderColor: label.color }}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: label.color }} />
              <span style={{ color: label.color }} className="text-[11px] font-extrabold">{label.title}</span>
            </div>
            <div className="font-medium text-slate-500 leading-relaxed text-[9px]">{label.detail}</div>
          </div>
        </Html>
      ))}
    </group>
  );
};

/* ── Floor — soft neutral ground plane with grid texture ── */
const GridFloor: React.FC = () => {
  const gridTexture = useMemo(() => {
    const size = 512;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    const step = size / 8;
    for (let i = 0; i <= 8; i++) {
      const p = i * step;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    return tex;
  }, []);

  return (
    <mesh position={[0, -0.5, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
      <planeGeometry args={[24, 24]} />
      <meshStandardMaterial
        map={gridTexture}
        roughness={0.85}
        metalness={0.0}
        color="#ffffff"
        transparent
        opacity={0.42}
      />
    </mesh>
  );
};

// 手部骨架连接定义 (从第一版移植)
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],   // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],   // 食指
  [0, 9], [9, 10], [10, 11], [11, 12], // 中指
  [0, 13], [13, 14], [14, 15], [15, 16], // 无名指
  [0, 17], [17, 18], [18, 19], [19, 20], // 小指
  [5, 9], [9, 13], [13, 17]         // 掌心连接
];

// 3D虚拟手组件 (从第一版移植)
const HAND_VISIBILITY_GRACE_MS = 180;
const HAND_POSITION_FILTER_TIME_CONSTANT_MS = 35;
const HAND_PLANE_DISTANCE = 2.85;
const HAND_DEPTH_SCALE = 0.48;
const HAND_DEPTH_LIMIT = 0.18;
const HAND_RENDER_ORDER = 40;
const PINCH_VISUAL_THRESHOLD = 0.055;
const HAND_FINGERTIPS = new Set([4, 8, 12, 16, 20]);
const HAND_HIGHLIGHT_JOINTS = new Set([4, 8]);

type VirtualHandRuntime = {
  leftBody: THREE.InstancedMesh;
  rightBody: THREE.InstancedMesh;
  thumbTips: THREE.InstancedMesh;
  indexTips: THREE.InstancedMesh;
  lines: THREE.LineSegments;
  linePositions: Float32Array;
  leftPositions: THREE.Vector3[];
  rightPositions: THREE.Vector3[];
  leftLastSeen: number;
  rightLastSeen: number;
  matrix: THREE.Matrix4;
  identityQuaternion: THREE.Quaternion;
  scale: THREE.Vector3;
};

const writeLineSegment = (
  target: Float32Array,
  offset: number,
  start: THREE.Vector3 | undefined,
  end: THREE.Vector3 | undefined,
  visible: boolean,
) => {
  if (!visible || !start || !end) {
    target[offset] = 0;
    target[offset + 1] = 0;
    target[offset + 2] = 0;
    target[offset + 3] = 0;
    target[offset + 4] = 0;
    target[offset + 5] = 0;
    return;
  }

  target[offset] = start.x;
  target[offset + 1] = start.y;
  target[offset + 2] = start.z;
  target[offset + 3] = end.x;
  target[offset + 4] = end.y;
  target[offset + 5] = end.z;
};

const setInstancedJoint = (
  mesh: THREE.InstancedMesh,
  index: number,
  position: THREE.Vector3 | undefined,
  size: number,
  visible: boolean,
  runtime: VirtualHandRuntime,
) => {
  if (!visible || !position) {
    runtime.matrix.makeScale(0, 0, 0);
  } else {
    runtime.scale.set(size, size, size);
    runtime.matrix.compose(position, runtime.identityQuaternion, runtime.scale);
  }
  mesh.setMatrixAt(index, runtime.matrix);
};

const renderVirtualHand = (
  runtime: VirtualHandRuntime,
  positions: THREE.Vector3[],
  side: 0 | 1,
  visible: boolean,
  isPinching: boolean,
) => {
  const body = side === 0 ? runtime.leftBody : runtime.rightBody;
  const jointBaseSize = side === 0 ? 0.014 : 0.014;

  // Body instances intentionally keep the thumb/index slots empty. Those two
  // slots are rendered by the accent instanced meshes below.
  for (let index = 0; index < 21; index += 1) {
    const isAccent = index === 4 || index === 8;
    const isFingertip = HAND_FINGERTIPS.has(index);
    const size = isFingertip ? 0.022 : jointBaseSize;
    setInstancedJoint(body, index, positions[index], size, visible && !isAccent, runtime);
  }

  const thumb = positions[4];
  const indexTip = positions[8];
  setInstancedJoint(runtime.thumbTips, side, thumb, 0.022 * (isPinching ? 1.45 : 1), visible, runtime);
  setInstancedJoint(runtime.indexTips, side, indexTip, 0.022 * (isPinching ? 1.45 : 1), visible, runtime);

  const connectionFloatCount = HAND_CONNECTIONS.length * 2 * 3;
  const connectionOffset = side * connectionFloatCount;
  HAND_CONNECTIONS.forEach((connection, index) => {
    const offset = connectionOffset + index * 6;
    writeLineSegment(
      runtime.linePositions,
      offset,
      positions[connection[0]],
      positions[connection[1]],
      visible,
    );
  });

  const pinchOffset = connectionFloatCount * 2 + side * 6;
  writeLineSegment(runtime.linePositions, pinchOffset, thumb, indexTip, visible && isPinching);
};

const VirtualHand: React.FC<{ controlRef: React.MutableRefObject<ControlRefs> }> = ({ controlRef }) => {
  const { camera } = useThree();
  const groupRef = useRef<THREE.Group>(null);
  const runtimeRef = useRef<VirtualHandRuntime | null>(null);
  const scratchRef = useRef({ targetLocal: new THREE.Vector3() });

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const createJointMaterial = (color: number, opacity: number) => new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const createLineMaterial = () => new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });

    // Four instanced meshes replace 42 independent sphere draw calls.
    const jointGeometry = new THREE.SphereGeometry(1, 8, 8);
    const leftMaterial = createJointMaterial(0xff8a5b, 0.74);
    const rightMaterial = createJointMaterial(0x2dd4ff, 0.76);
    const thumbMaterial = createJointMaterial(0xff4d5a, 0.95);
    const indexMaterial = createJointMaterial(0xffd54a, 0.95);
    const leftBody = new THREE.InstancedMesh(jointGeometry, leftMaterial, 21);
    const rightBody = new THREE.InstancedMesh(jointGeometry, rightMaterial, 21);
    const thumbTips = new THREE.InstancedMesh(jointGeometry, thumbMaterial, 2);
    const indexTips = new THREE.InstancedMesh(jointGeometry, indexMaterial, 2);
    [leftBody, rightBody, thumbTips, indexTips].forEach((mesh) => {
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.renderOrder = HAND_RENDER_ORDER;
      mesh.frustumCulled = false;
    });

    // One dynamic line buffer carries both skeletons and both pinch guides.
    const lineSegmentCount = HAND_CONNECTIONS.length * 2 + 2;
    const linePositions = new Float32Array(lineSegmentCount * 2 * 3);
    const lineColors = new Float32Array(linePositions.length);
    const leftColor = new THREE.Color(0xff8a5b);
    const rightColor = new THREE.Color(0x2dd4ff);
    const pinchColor = new THREE.Color(0xfff1a6);
    const setVertexColor = (vertexIndex: number, color: THREE.Color) => {
      const offset = vertexIndex * 3;
      lineColors[offset] = color.r;
      lineColors[offset + 1] = color.g;
      lineColors[offset + 2] = color.b;
    };
    let vertexIndex = 0;
    for (let side = 0; side < 2; side += 1) {
      const color = side === 0 ? leftColor : rightColor;
      for (let index = 0; index < HAND_CONNECTIONS.length; index += 1) {
        setVertexColor(vertexIndex, color);
        setVertexColor(vertexIndex + 1, color);
        vertexIndex += 2;
      }
    }
    for (let index = 0; index < 2; index += 1) {
      setVertexColor(vertexIndex, pinchColor);
      setVertexColor(vertexIndex + 1, pinchColor);
      vertexIndex += 2;
    }

    const lineGeometry = new THREE.BufferGeometry();
    const linePositionAttribute = new THREE.BufferAttribute(linePositions, 3);
    linePositionAttribute.setUsage(THREE.DynamicDrawUsage);
    lineGeometry.setAttribute('position', linePositionAttribute);
    lineGeometry.setAttribute('color', new THREE.BufferAttribute(lineColors, 3));
    const lines = new THREE.LineSegments(lineGeometry, createLineMaterial());
    lines.renderOrder = HAND_RENDER_ORDER;
    lines.frustumCulled = false;

    const runtime: VirtualHandRuntime = {
      leftBody,
      rightBody,
      thumbTips,
      indexTips,
      lines,
      linePositions,
      leftPositions: Array.from({ length: 21 }, () => new THREE.Vector3()),
      rightPositions: Array.from({ length: 21 }, () => new THREE.Vector3()),
      leftLastSeen: 0,
      rightLastSeen: 0,
      matrix: new THREE.Matrix4(),
      identityQuaternion: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
    };
    runtimeRef.current = runtime;

    group.add(leftBody, rightBody, thumbTips, indexTips, lines);

    return () => {
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      group.remove(leftBody, rightBody, thumbTips, indexTips, lines);
      lineGeometry.dispose();
      jointGeometry.dispose();
      leftMaterial.dispose();
      rightMaterial.dispose();
      thumbMaterial.dispose();
      indexMaterial.dispose();
      (lines.material as THREE.Material).dispose();
    };
  }, []);

  useFrame((_, delta) => {
    const runtime = runtimeRef.current;
    const group = groupRef.current;
    if (!runtime || !group) return;

    group.position.copy(camera.position);
    group.quaternion.copy(camera.quaternion);

    let halfWidth = 1;
    let halfHeight = 1;
    if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const perspectiveCamera = camera as THREE.PerspectiveCamera;
      halfHeight = Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov) / 2) * HAND_PLANE_DISTANCE;
      halfWidth = halfHeight * perspectiveCamera.aspect;
    } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      const orthographicCamera = camera as THREE.OrthographicCamera;
      halfWidth = (orthographicCamera.right - orthographicCamera.left) / (2 * orthographicCamera.zoom);
      halfHeight = (orthographicCamera.top - orthographicCamera.bottom) / (2 * orthographicCamera.zoom);
    }

    const now = performance.now();
    // Keep the virtual hand's visual smoothing stable across 30/60/120Hz.
    // This is intentionally separate from the control filter: the model
    // consumes the already-filtered pointer/rates, while the hand overlay can
    // use a slightly softer visual response without adding control latency.
    const handPositionAlpha = 1 - Math.exp(
      -Math.min(Math.max(delta, 0), 0.05) * 1000 / HAND_POSITION_FILTER_TIME_CONSTANT_MS,
    );
    const scratch = scratchRef.current;
    const updateHand = (
      landmarks: { x: number; y: number; z: number }[] | null,
      positions: THREE.Vector3[],
      side: 0 | 1,
      lastSeen: number,
    ) => {
      const valid = Boolean(landmarks && landmarks.length >= 21);
      const withinGrace = lastSeen > 0 && now - lastSeen <= HAND_VISIBILITY_GRACE_MS;
      if (!valid) {
        renderVirtualHand(runtime, positions, side, withinGrace, false);
        // Do not refresh the timestamp while the input is missing; otherwise
        // the grace window would be extended forever and a lost hand would
        // remain rendered indefinitely.
        return lastSeen;
      }

      const hasPreviousPositions = withinGrace;
      for (let index = 0; index < 21; index += 1) {
        const point = landmarks![index];
        const ndcX = (0.5 - point.x) * 2;
        const ndcY = -(point.y - 0.5) * 2;
        const depthOffset = THREE.MathUtils.clamp((point.z || 0) * HAND_DEPTH_SCALE, -HAND_DEPTH_LIMIT, HAND_DEPTH_LIMIT);
        scratch.targetLocal.set(
          ndcX * halfWidth,
          ndcY * halfHeight,
          -HAND_PLANE_DISTANCE + depthOffset,
        );
        if (hasPreviousPositions) {
          positions[index].lerp(scratch.targetLocal, handPositionAlpha);
        } else {
          positions[index].copy(scratch.targetLocal);
        }
      }

      const thumb = landmarks![4];
      const indexTip = landmarks![8];
      const pinchDistance = Math.hypot(thumb.x - indexTip.x, thumb.y - indexTip.y);
      renderVirtualHand(runtime, positions, side, true, pinchDistance < PINCH_VISUAL_THRESHOLD);
      return now;
    };

    runtime.leftLastSeen = updateHand(
      controlRef.current.handLandmarks.left,
      runtime.leftPositions,
      0,
      runtime.leftLastSeen,
    );
    runtime.rightLastSeen = updateHand(
      controlRef.current.handLandmarks.right,
      runtime.rightPositions,
      1,
      runtime.rightLastSeen,
    );

    runtime.leftBody.instanceMatrix.needsUpdate = true;
    runtime.rightBody.instanceMatrix.needsUpdate = true;
    runtime.thumbTips.instanceMatrix.needsUpdate = true;
    runtime.indexTips.instanceMatrix.needsUpdate = true;
    (runtime.lines.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });

  return <group ref={groupRef} />;
};

/** Sets the camera initial position based on model type */
const CameraInit: React.FC<{ modelUrl: string; target: CameraTarget }> = ({ modelUrl, target }) => {
  const { camera } = useThree();
  const controls = useThree((s) => (s as any).controls);

  useEffect(() => {
    const lower = modelUrl.toLowerCase();
    if (lower.includes('心脏模型') || lower.includes('heart')) {
      camera.position.set(0, 1.5, 4.5);
    } else {
      camera.position.set(3.5, 4, 3.5);
    }
    camera.lookAt(...target);
    controls?.update?.();
  }, [modelUrl]);

  return null;
};

const CameraPresentationTransition: React.FC<{ active: boolean; target: CameraTarget }> = ({ active, target }) => {
  const { camera } = useThree();
  const controls = useThree((state) => (state as any).controls);
  const currentFactorRef = useRef(1);
  const targetFactorRef = useRef(1);
  const targetVector = useMemo(() => new THREE.Vector3(...target), [target]);
  const offsetRef = useRef(new THREE.Vector3());

  useEffect(() => {
    targetFactorRef.current = active ? 1.15 : 1;
    const reduceMotion = typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion || currentFactorRef.current === targetFactorRef.current) return;

    const ratio = targetFactorRef.current / currentFactorRef.current;
    offsetRef.current.subVectors(camera.position, targetVector).multiplyScalar(ratio);
    camera.position.copy(targetVector).add(offsetRef.current);
    camera.lookAt(targetVector);
    controls?.update?.();
    currentFactorRef.current = targetFactorRef.current;
  }, [active, camera, controls, targetVector]);

  useFrame((_, delta) => {
    const current = currentFactorRef.current;
    const desired = targetFactorRef.current;
    if (Math.abs(current - desired) < 0.0005) {
      currentFactorRef.current = desired;
      return;
    }

    const next = THREE.MathUtils.damp(current, desired, 6.5, delta);
    const ratio = next / current;
    offsetRef.current.subVectors(camera.position, targetVector).multiplyScalar(ratio);
    camera.position.copy(targetVector).add(offsetRef.current);
    camera.lookAt(targetVector);
    controls?.update?.();
    currentFactorRef.current = next;
  });

  return null;
};

/** Adapt pixel ratio to interaction state: cap fill-rate during gestures and
 * restore sharper rendering only after a short idle period. This runs inside
 * R3F without React state churn. */
const AdaptiveRenderQuality: React.FC<{ controlRef: React.MutableRefObject<ControlRefs> }> = ({ controlRef }) => {
  const { gl } = useThree();
  const lastActiveAt = useRef(0);
  const appliedDpr = useRef(0);
  const wasActive = useRef(false);
  const hasInteracted = useRef(false);
  const shadowRefreshFrames = useRef(0);

  useEffect(() => () => {
    // Do not leak a paused shadow map if the viewer is unmounted while a
    // gesture is in progress or while the model is being switched.
    gl.shadowMap.autoUpdate = true;
  }, [gl]);

  useFrame(() => {
    const now = performance.now();
    const controls = controlRef.current;
    // A visible hand is not necessarily interacting.  Keep the fill-rate cap
    // and shadow pause tied to actual motion/dragging so an idle hand can
    // recover the sharper stable quality after the gesture ends.
    const active = controls.isDragging ||
      Math.abs(controls.rotationVelocity.x) > 0.0001 ||
      Math.abs(controls.rotationVelocity.y) > 0.0001 ||
      Math.abs(controls.zoomSpeed) > 0.0001;
    if (active) {
      lastActiveAt.current = now;
      hasInteracted.current = true;
    }

    if (active && !wasActive.current) {
      gl.shadowMap.autoUpdate = false;
      shadowRefreshFrames.current = 0;
    } else if (!active && wasActive.current) {
      // One shadow refresh after release keeps the resting pose correct while
      // avoiding a full shadow pass on every interaction frame.
      gl.shadowMap.autoUpdate = true;
      gl.shadowMap.needsUpdate = true;
      shadowRefreshFrames.current = 1;
    } else if (!active && shadowRefreshFrames.current > 0) {
      shadowRefreshFrames.current -= 1;
      if (shadowRefreshFrames.current === 0) gl.shadowMap.autoUpdate = false;
    }
    wasActive.current = active;

    const deviceDpr = window.devicePixelRatio || 1;
    const target = !hasInteracted.current
      ? 1
      : now - lastActiveAt.current < 900
        ? Math.min(deviceDpr, MAX_RENDER_DPR)
        : Math.min(deviceDpr, STABLE_RENDER_DPR);
    if (Math.abs(appliedDpr.current - target) > 0.01) {
      gl.setPixelRatio(target);
      appliedDpr.current = target;
    }
  });
  return null;
};

const ModelViewer: React.FC<ModelViewerProps> = ({ modelUrl, modelType, assetUrls, controlRef, showLabels: externalShowLabels, onShowLabelsChange, onLoadProgress, onLoadComplete, onLoadError, onPartMoved, onDisassemblyAvailabilityChange, quizMode = false, presentationSplitActive = false }) => {
  const { themeDef } = useTheme();
  const dirLightRef = useRef<THREE.DirectionalLight>(null);
  const [internalShowLabels, setInternalShowLabels] = useState(false);
  const [contactShadowRevision, setContactShadowRevision] = useState(0);
  const showLabels = externalShowLabels !== undefined ? externalShowLabels : internalShowLabels;
  const setShowLabels = onShowLabelsChange || setInternalShowLabels;
  const lastAutoLabelActionRef = useRef(-1);
  const terrainLoadNotifiedRef = useRef<string | null>(null);
  const lowerModelUrl = modelUrl.toLowerCase();
  const assetModelUrl = resolveModelAssetUrl(resolveInteractiveModelUrl(modelUrl, assetUrls));
  const cameraTarget = useMemo<CameraTarget>(() => {
    if (lowerModelUrl.includes('earth-layers')) return [0, 1.5, 0];
    if (lowerModelUrl.includes('terrain-topography')) return [0, 0.5, 0];
    return [0, 0.3, 0];
  }, [lowerModelUrl]);

  // ContactShadows is deliberately rendered for one frame at a time. Remount
  // it after a model finishes loading or a part is released so the expensive
  // shadow capture is event-driven instead of running on every render frame.
  const handleModelLoadComplete = useCallback(() => {
    setContactShadowRevision((revision) => revision + 1);
    onLoadComplete?.();
  }, [onLoadComplete]);
  const handlePartMoved = useCallback((partName: string) => {
    setContactShadowRevision((revision) => revision + 1);
    onPartMoved?.(partName);
  }, [onPartMoved]);

  useEffect(() => {
    if (lowerModelUrl.includes('earth-layers')) {
      setShowLabels(true);
    } else {
      setShowLabels(false);
    }
    lastAutoLabelActionRef.current = controlRef.current.agentDisassembly?.actionId ?? -1;
  }, [controlRef, modelUrl, lowerModelUrl]);

  useEffect(() => {
    if (!lowerModelUrl.includes('terrain-topography')) {
      terrainLoadNotifiedRef.current = null;
      return;
    }
    if (terrainLoadNotifiedRef.current === modelUrl) return;
    terrainLoadNotifiedRef.current = modelUrl;
    handleModelLoadComplete();
  }, [handleModelLoadComplete, lowerModelUrl, modelUrl]);

  useEffect(() => {
    let animationFrame = 0;

    const syncEarthLabelsWithDisassembly = () => {
      const disassembly = controlRef.current.agentDisassembly;
      const isNewEarthDisassembly =
        lowerModelUrl.includes('earth-layers') &&
        Boolean(disassembly?.enabled) &&
        disassembly.actionId !== lastAutoLabelActionRef.current;

      if (isNewEarthDisassembly) {
        lastAutoLabelActionRef.current = disassembly.actionId;
        setShowLabels(true);
      }

      animationFrame = requestAnimationFrame(syncEarthLabelsWithDisassembly);
    };

    animationFrame = requestAnimationFrame(syncEarthLabelsWithDisassembly);
    return () => cancelAnimationFrame(animationFrame);
  }, [controlRef, lowerModelUrl]);

  return (
    <div className="w-full h-full bg-transparent relative">
      <Canvas
        shadows
        // Limit render resolution on HiDPI screens; gesture latency is more
        // sensitive to fill-rate than to a marginally sharper shadow edge.
        dpr={[1, STABLE_RENDER_DPR]}
        camera={{ position: [3.5, 4, 3.5], fov: 45, near: 0.1, far: 100 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, alpha: true }}
        raycaster={{ far: 100 }}
        onCreated={({ gl }) => { gl.setClearColor('#020812', 0); }}
      >
        <Suspense fallback={null}>
          <AdaptiveRenderQuality controlRef={controlRef} />
          {/* ---- Lighting — warm & soft (from 环境 package) ---- */}
          <ambientLight intensity={0.6} color="#fff8f0" />
          <directionalLight
            ref={dirLightRef}
            position={[5, 8, 4]}
            intensity={1.2}
            color="#ffffff"
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
            shadow-camera-left={-5}
            shadow-camera-right={5}
            shadow-camera-top={5}
            shadow-camera-bottom={-5}
            shadow-camera-near={0.5}
            shadow-camera-far={20}
            shadow-bias={-0.0005}
          />
          <pointLight position={[-4, 3, 2]} intensity={0.3} color="#e0f0ff" />
          <pointLight position={[3, 2, -3]} intensity={0.2} color="#fff0e8" />

          {/* ---- Local environment reflections ---- */}
          <LocalEnvironment />

          {/* ---- Uploaded Model ---- */}
          {lowerModelUrl.includes('terrain-topography') ? (
            <ProceduralTerrain
              controlRef={controlRef}
              showLabels={showLabels}
              cameraTarget={cameraTarget}
            />
          ) : (
            <>
              <LayeredModel
                url={assetModelUrl}
                modelType={modelType}
                assetUrls={assetUrls}
                controlRef={controlRef}
                cameraTarget={cameraTarget}
                accent={themeDef.accent}
                showEarthLabels={lowerModelUrl.includes('earth-layers') && showLabels}
                onDisassemblyAvailabilityChange={onDisassemblyAvailabilityChange}
                onLoadProgress={onLoadProgress}
                onLoadComplete={handleModelLoadComplete}
                onLoadError={onLoadError}
                onPartMoved={handlePartMoved}
              />
            </>
          )}

          {/* 3D虚拟手骨架可视化 */}
          {!quizMode && <VirtualHand controlRef={controlRef} />}

          {/* ---- Contact shadows on floor ---- */}
          <ContactShadows
            key={`${assetModelUrl}:${contactShadowRevision}`}
            position={[0, -0.49, 0]}
            opacity={0.12}
            scale={14}
            blur={3}
            far={4}
            frames={1}
            resolution={256}
            smooth={false}
            color="#cbd5e1"
          />

          {/* ---- Camera controls ---- */}
          <OrbitControls
            makeDefault
            target={cameraTarget}
            enablePan={false}
            enableZoom={true}
            minPolarAngle={Math.PI / 6}
            maxPolarAngle={Math.PI / 2.2}
            minDistance={3}
            maxDistance={12}
            enableDamping
            dampingFactor={0.045}
            rotateSpeed={0.35}
            zoomSpeed={0.9}
          />
          <CameraInit modelUrl={modelUrl} target={cameraTarget} />
          <CameraPresentationTransition key={modelUrl} active={presentationSplitActive} target={cameraTarget} />
        </Suspense>
      </Canvas>
    </div>
  );
};

export default ModelViewer;
