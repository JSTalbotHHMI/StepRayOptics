// Pure optics math shared by every geometry backend (ported verbatim from
// StepRayOptics/js/tracer.js — the physics is identical; only how a ray finds its next
// surface differs between the triangle-BVH tracer there and the B-rep tracer here).

import * as THREE from 'three';

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

// A single random direction, uniformly sampled over the solid angle of a cap of
// half-angle `maxAngleDeg` around `axis` (0° → always returns `axis` itself). Used for
// surface/body emitters in "max angle from normal" mode, where each sampled emission
// point on the body needs its own independent random direction — unlike
// emissionDirections' deterministic fan (shared by a single point light), every call
// here draws fresh, so many calls around many different axes look like independent
// per-point Monte Carlo sampling rather than one repeated fixed pattern.
export function randomConeDirection(axis, maxAngleDeg) {
  const cosCap = Math.cos(THREE.MathUtils.degToRad(maxAngleDeg));
  const cosA = cosCap + Math.random() * (1 - cosCap); // uniform in [cosCap, 1]
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const phi = Math.random() * Math.PI * 2;

  const w = axis.clone().normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(w.x) > 0.9) u.set(0, 1, 0);
  u.cross(w).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);

  return new THREE.Vector3()
    .addScaledVector(u, sinA * Math.cos(phi))
    .addScaledVector(v, sinA * Math.sin(phi))
    .addScaledVector(w, cosA)
    .normalize();
}

// A random direction around `axis` with its polar angle drawn from `angleSampler`
// (see angularProfile.buildAngleSampler) instead of sampled uniformly over solid angle —
// this is how a custom angular profile now shapes emission: ray DENSITY varies with the
// profile's curve, every ray carrying the same fixed energy, rather than a uniform-
// density fan with per-ray energy weighted by the curve.
export function profileWeightedDirection(axis, angleSampler) {
  const theta = THREE.MathUtils.degToRad(angleSampler.sampleAngleDeg());
  const phi = Math.random() * Math.PI * 2;
  const sinT = Math.sin(theta), cosT = Math.cos(theta);

  const w = axis.clone().normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(w.x) > 0.9) u.set(0, 1, 0);
  u.cross(w).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);

  return new THREE.Vector3()
    .addScaledVector(u, sinT * Math.cos(phi))
    .addScaledVector(v, sinT * Math.sin(phi))
    .addScaledVector(w, cosT)
    .normalize();
}

// A cosine-weighted random direction over the hemisphere around `normal` — the
// standard diffuse (Lambertian) re-emission model for a phosphor conversion event
// (Phase 6/7): more likely to emit near the normal than at grazing angles, matching
// how a real phosphor coating scatters the light it re-emits.
export function cosineWeightedHemisphereDirection(normal) {
  const r1 = Math.random(), r2 = Math.random();
  const r = Math.sqrt(r1);
  const theta = 2 * Math.PI * r2;
  const x = r * Math.cos(theta), y = r * Math.sin(theta);
  const z = Math.sqrt(Math.max(0, 1 - r1));

  const w = normal.clone().normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(w.x) > 0.9) u.set(0, 1, 0);
  u.cross(w).normalize();
  const v = new THREE.Vector3().crossVectors(w, u);

  return new THREE.Vector3()
    .addScaledVector(u, x)
    .addScaledVector(v, y)
    .addScaledVector(w, z)
    .normalize();
}

// A uniform random direction over the full sphere — used to re-emit a volumetric
// phosphor conversion event (Phase 7), where the conversion point is inside the body's
// volume and there is no surface normal to weight the re-emission toward.
export function randomIsotropicDirection() {
  const z = 2 * Math.random() - 1;
  const theta = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return new THREE.Vector3(r * Math.cos(theta), r * Math.sin(theta), z);
}

// Exact unpolarized Fresnel reflectance for dielectrics.
export function fresnelR(n1, n2, cosI, cosT) {
  const rs = (n1 * cosI - n2 * cosT) / (n1 * cosI + n2 * cosT);
  const rp = (n1 * cosT - n2 * cosI) / (n1 * cosT + n2 * cosI);
  return 0.5 * (rs * rs + rp * rp);
}

/**
 * Given an incoming ray direction and the OUTWARD surface normal (already oriented
 * against the incoming ray, i.e. dot(dir, normal) < 0), computes the Snell/Fresnel/TIR
 * split for one surface hit. Geometry-agnostic: the caller supplies the normal however
 * it was obtained (analytic B-rep evaluation here; a triangle normal in StepRayOptics).
 *
 * @param dir        THREE.Vector3, incoming ray direction (unit)
 * @param normal     THREE.Vector3, outward normal at the hit, unit, same side as -dir
 * @param n1          index of refraction of the medium the ray is leaving
 * @param n2          index of refraction of the medium the ray is entering
 * @param manualReflectivity  0..1, or null to use the physical Fresnel coefficient
 * @returns {{ reflectDir: THREE.Vector3, refractDir: THREE.Vector3|null, R: number, tir: boolean }}
 */
export function computeBounce(dir, normal, n1, n2, manualReflectivity) {
  const cosI = -dir.dot(normal);
  const eta = n1 / n2;
  const sinT2 = eta * eta * (1 - cosI * cosI);
  const tir = sinT2 > 1;
  const cosT = tir ? 0 : Math.sqrt(1 - sinT2);

  let R;
  if (tir) R = 1;
  else if (manualReflectivity !== null && manualReflectivity !== undefined) R = manualReflectivity;
  else R = fresnelR(n1, n2, cosI, cosT);

  const reflectDir = dir.clone().reflect(normal).normalize();
  const refractDir = tir ? null : dir.clone().multiplyScalar(eta)
    .addScaledVector(normal, eta * cosI - cosT)
    .normalize();

  return { reflectDir, refractDir, R, tir };
}

// Build one LineSegments object from a flat list of traced segments, each already
// carrying its own `rgb` (the ray's wavelength at that point in its path — see
// brepTracer.js; a phosphor-converted ray's tail is a different color than its head).
// Additive blending means overlapping spectral rays (before dispersion/reflection
// separates them) sum toward white, same as before this was per-segment instead of
// per-batch. `gain` converts a ray's relative energy to screen brightness — the caller
// derives it from source power / ray count so brightness is power-conserving.
export function buildRayLines(segments, gain) {
  const total = segments.length;
  const positions = new Float32Array(total * 6);
  const colors = new Float32Array(total * 6);
  let i = 0;
  for (const s of segments) {
    positions[i * 6 + 0] = s.a.x;
    positions[i * 6 + 1] = s.a.y;
    positions[i * 6 + 2] = s.a.z;
    positions[i * 6 + 3] = s.b.x;
    positions[i * 6 + 4] = s.b.y;
    positions[i * 6 + 5] = s.b.z;
    const w = Math.min(1, s.energy * gain);
    for (const off of [0, 3]) {
      colors[i * 6 + off + 0] = s.rgb[0] * w;
      colors[i * 6 + off + 1] = s.rgb[1] * w;
      colors[i * 6 + off + 2] = s.rgb[2] * w;
    }
    i++;
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
