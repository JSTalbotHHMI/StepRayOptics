// Geometric-optics ray tracer.
//
// Rays are emitted from a point source and traced against the scene meshes.
// At every surface hit the ray splits into a reflected and a refracted branch
// (Snell's law). The energy split is either the physical Fresnel coefficient
// (unpolarized) or a user-set per-surface reflectivity. Branches die when
// their energy drops below `minIntensity` or `maxBounces` is exceeded.

import * as THREE from 'three';

const MAX_SEGMENTS = 400000;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Approximate conversion of a visible wavelength (nm) to linear RGB.
export function wavelengthToRGB(wl) {
  let r = 0, g = 0, b = 0;
  if (wl >= 380 && wl < 440) { r = -(wl - 440) / 60; b = 1; }
  else if (wl < 490) { g = (wl - 440) / 50; b = 1; }
  else if (wl < 510) { g = 1; b = -(wl - 510) / 20; }
  else if (wl < 580) { r = (wl - 510) / 70; g = 1; }
  else if (wl < 645) { r = 1; g = -(wl - 645) / 65; }
  else if (wl <= 750) { r = 1; }
  // fade toward the edges of the visible range
  let f = 1;
  if (wl >= 380 && wl < 420) f = 0.3 + 0.7 * (wl - 380) / 40;
  else if (wl > 700 && wl <= 750) f = 0.3 + 0.7 * (750 - wl) / 50;
  const gamma = 0.8;
  return [
    Math.pow(r * f, gamma),
    Math.pow(g * f, gamma),
    Math.pow(b * f, gamma),
  ];
}

// Deterministic, evenly spaced directions (Fibonacci spiral) either over the
// full sphere or over a spherical cap of half-angle `coneAngle` around `axis`.
export function emissionDirections(count, mode, axis, coneAngleDeg) {
  const dirs = [];
  const cosCap = mode === 'sphere'
    ? -1 // full sphere
    : Math.cos(THREE.MathUtils.degToRad(coneAngleDeg));

  // orthonormal basis around the axis
  const w = axis.clone().normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(w.x) > 0.9) u.set(0, 1, 0);
  u.cross(w).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);

  for (let k = 0; k < count; k++) {
    const cosA = 1 - (1 - cosCap) * ((k + 0.5) / count);
    const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const phi = GOLDEN_ANGLE * k;
    const d = new THREE.Vector3()
      .addScaledVector(u, sinA * Math.cos(phi))
      .addScaledVector(v, sinA * Math.sin(phi))
      .addScaledVector(w, cosA);
    dirs.push(d.normalize());
  }
  return dirs;
}

function findFace(faces, triIndex) {
  let lo = 0, hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = faces[mid];
    if (triIndex < f.first) hi = mid - 1;
    else if (triIndex > f.last) lo = mid + 1;
    else return f;
  }
  return null;
}

// Exact unpolarized Fresnel reflectance for dielectrics.
function fresnelR(n1, n2, cosI, cosT) {
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * @param objects  array of SceneObjects ({ mesh, material, faces })
 * @param params   { origin, directions, maxBounces, minIntensity, maxDist, eps, iors }
 *                 `iors` is a Map<SceneObject, number> giving each object's index
 *                 of refraction at the wavelength being traced.
 * @returns { segments: [{a,b,energy}], stats }
 */
export function traceRays(objects, params) {
  const t0 = performance.now();
  const { origin, directions, maxBounces, minIntensity, maxDist, eps, iors } = params;

  const meshes = objects.map((o) => o.mesh);
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.near = 0;
  raycaster.far = maxDist * 4;

  const segments = [];
  let capped = false;
  let maxDepthReached = 0;

  const normalMatrix = new THREE.Matrix3();
  const worldNormal = new THREE.Vector3();

  const stack = [];
  for (const dir of directions) {
    stack.push({ origin: origin.clone(), dir: dir.clone(), energy: 1, depth: 0 });
  }

  while (stack.length > 0) {
    if (segments.length >= MAX_SEGMENTS) { capped = true; break; }
    const ray = stack.pop();
    maxDepthReached = Math.max(maxDepthReached, ray.depth);

    // offset the start slightly so we don't re-hit the surface we just left
    const start = ray.origin.clone().addScaledVector(ray.dir, eps);
    raycaster.set(start, ray.dir);
    const hits = meshes.length > 0 ? raycaster.intersectObjects(meshes, false) : [];

    if (hits.length === 0) {
      const end = start.clone().addScaledVector(ray.dir, maxDist);
      segments.push({ a: ray.origin, b: end, energy: ray.energy });
      continue;
    }

    const hit = hits[0];
    segments.push({ a: ray.origin, b: hit.point, energy: ray.energy });

    if (ray.depth >= maxBounces) continue;

    const obj = hit.object.userData.sceneObject;
    const face = findFace(obj.faces, hit.faceIndex);

    // geometric (flat) triangle normal in world space
    normalMatrix.getNormalMatrix(hit.object.matrixWorld);
    worldNormal.copy(hit.face.normal).applyMatrix3(normalMatrix).normalize();

    // orient the normal against the incoming ray; pick media accordingly
    const objIor = iors.get(obj);
    let n1 = 1.0;
    let n2 = objIor;
    const n = worldNormal.clone();
    let cosI = -ray.dir.dot(n);
    if (cosI < 0) {
      // hit from the inside: leaving the material
      n.negate();
      cosI = -cosI;
      n1 = objIor;
      n2 = 1.0;
    }

    const eta = n1 / n2;
    const sinT2 = eta * eta * (1 - cosI * cosI);
    const tir = sinT2 > 1;
    const cosT = tir ? 0 : Math.sqrt(1 - sinT2);

    let R;
    if (tir) R = 1;
    else if (face && face.reflectivity !== null) R = face.reflectivity;
    else R = fresnelR(n1, n2, cosI, cosT);

    const reflectedEnergy = ray.energy * R;
    const refractedEnergy = ray.energy * (1 - R);

    if (reflectedEnergy >= minIntensity) {
      const rdir = ray.dir.clone().reflect(n).normalize();
      stack.push({ origin: hit.point.clone(), dir: rdir, energy: reflectedEnergy, depth: ray.depth + 1 });
    }
    if (!tir && refractedEnergy >= minIntensity) {
      const tdir = ray.dir.clone().multiplyScalar(eta)
        .addScaledVector(n, eta * cosI - cosT)
        .normalize();
      stack.push({ origin: hit.point.clone(), dir: tdir, energy: refractedEnergy, depth: ray.depth + 1 });
    }
  }

  return {
    segments,
    stats: {
      raysEmitted: directions.length,
      segments: segments.length,
      maxDepthReached,
      capped,
      timeMs: performance.now() - t0,
    },
  };
}

// Build one LineSegments object from traced segment batches, one batch per
// wavelength: [{ segments, rgb }, ...]. Batches blend additively, so where
// spectral rays overlap (before dispersion separates them) they sum to white.
// `gain` converts a ray's relative energy to screen brightness — the caller
// derives it from source power / ray count so brightness is power-conserving.
export function buildRayLines(batches, gain) {
  let total = 0;
  for (const b of batches) total += b.segments.length;
  const positions = new Float32Array(total * 6);
  const colors = new Float32Array(total * 6);
  let i = 0;
  for (const { segments, rgb } of batches) {
    for (const s of segments) {
      positions[i * 6 + 0] = s.a.x;
      positions[i * 6 + 1] = s.a.y;
      positions[i * 6 + 2] = s.a.z;
      positions[i * 6 + 3] = s.b.x;
      positions[i * 6 + 4] = s.b.y;
      positions[i * 6 + 5] = s.b.z;
      const w = Math.min(1, s.energy * gain);
      for (const off of [0, 3]) {
        colors[i * 6 + off + 0] = rgb[0] * w;
        colors[i * 6 + off + 1] = rgb[1] * w;
        colors[i * 6 + off + 2] = rgb[2] * w;
      }
      i++;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  return new THREE.LineSegments(geometry, material);
}
