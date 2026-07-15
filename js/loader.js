// STEP file loading (via occt-import-js WASM) and demo geometry construction.
// Every loaded model becomes a SceneObject:
//   { id, name, mesh, material, faces: [{ first, last, reflectivity }] }
// `faces` holds inclusive triangle-index ranges for each B-rep surface;
// reflectivity === null means "use Fresnel equations".

import * as THREE from 'three';
import { defaultMaterial } from './materials.js';

let occtPromise = null;

function getOcct() {
  if (!occtPromise) {
    occtPromise = occtimportjs({
      locateFile: (name) => 'vendor/' + name,
    });
  }
  return occtPromise;
}

let nextId = 1;

export function makeObjectMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x7fb8d8,
    metalness: 0.05,
    roughness: 0.25,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

function buildSceneObject(name, geometry, faces) {
  geometry.computeBoundsTree();
  const mesh = new THREE.Mesh(geometry, makeObjectMaterial());
  const obj = { id: nextId++, name, mesh, material: defaultMaterial(), faces };
  mesh.userData.sceneObject = obj;
  return obj;
}

// ---------------------------------------------------------------- STEP files

export async function loadStepFile(file) {
  const occt = await getOcct();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = occt.ReadStepFile(buffer, null);
  if (!result || !result.success || result.meshes.length === 0) {
    throw new Error(`Failed to parse ${file.name}`);
  }

  // Merge all solids in the file into one geometry so the whole file
  // shares one index of refraction, but keep per-B-rep-face ranges.
  let vertCount = 0;
  let triCount = 0;
  for (const m of result.meshes) {
    vertCount += m.attributes.position.array.length / 3;
    triCount += m.index.array.length / 3;
  }

  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const indices = triCount * 3 > 65535 ? new Uint32Array(triCount * 3) : new Uint16Array(triCount * 3);
  const faces = [];
  let hasNormals = true;

  let vOff = 0;
  let iOff = 0;
  let tOff = 0;
  for (const m of result.meshes) {
    positions.set(m.attributes.position.array, vOff * 3);
    if (m.attributes.normal) {
      normals.set(m.attributes.normal.array, vOff * 3);
    } else {
      hasNormals = false;
    }
    const idx = m.index.array;
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;

    const meshTris = idx.length / 3;
    if (m.brep_faces && m.brep_faces.length > 0) {
      for (const f of m.brep_faces) {
        faces.push({ first: f.first + tOff, last: f.last + tOff, reflectivity: null });
      }
    } else {
      faces.push({ first: tOff, last: tOff + meshTris - 1, reflectivity: null });
    }

    vOff += m.attributes.position.array.length / 3;
    iOff += idx.length;
    tOff += meshTris;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (hasNormals) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  } else {
    geometry.computeVertexNormals();
  }

  return buildSceneObject(file.name, geometry, faces);
}

// ---------------------------------------------------------------- demo shapes

// Equilateral triangular prism (like a classic dispersing prism).
// Built non-indexed so each flat surface is a contiguous triangle range.
export function makeDemoPrism(size = 20) {
  const h = size;           // prism length along Z
  const r = size * 0.7;     // triangle circumradius
  const tri = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 2;
    tri.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const zs = [-h / 2, h / 2];

  const pos = [];
  const faces = [];
  let t = 0;
  const quad = (a, b, c, d) => {
    // two triangles, outward winding supplied by caller
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    return 2;
  };

  // three rectangular side faces
  for (let i = 0; i < 3; i++) {
    const [x1, y1] = tri[i];
    const [x2, y2] = tri[(i + 1) % 3];
    const n = quad(
      [x1, y1, zs[0]], [x2, y2, zs[0]], [x2, y2, zs[1]], [x1, y1, zs[1]]
    );
    faces.push({ first: t, last: t + n - 1, reflectivity: null });
    t += n;
  }
  // back cap (z-) — clockwise when viewed from +z, so it faces -z
  pos.push(
    tri[0][0], tri[0][1], zs[0],
    tri[2][0], tri[2][1], zs[0],
    tri[1][0], tri[1][1], zs[0]
  );
  faces.push({ first: t, last: t, reflectivity: null });
  t += 1;
  // front cap (z+)
  pos.push(
    tri[0][0], tri[0][1], zs[1],
    tri[1][0], tri[1][1], zs[1],
    tri[2][0], tri[2][1], zs[1]
  );
  faces.push({ first: t, last: t, reflectivity: null });
  t += 1;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  // non-indexed geometries still need an index for face-range picking via drawRange;
  // build a trivial one so all models are handled identically
  const idx = new Uint16Array(pos.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.computeVertexNormals();

  return buildSceneObject('Demo Prism', geometry, faces);
}

// Ball lens — a sphere is a single B-rep surface.
export function makeDemoSphere(radius = 12) {
  const geometry = new THREE.SphereGeometry(radius, 48, 32);
  const triCount = geometry.getIndex().count / 3;
  const faces = [{ first: 0, last: triCount - 1, reflectivity: null }];
  return buildSceneObject('Demo Ball Lens', geometry, faces);
}
