// Ray tracer against the analytic B-rep face table built by occt.js.
//
// Every hit point and every surface normal here comes from OpenCascade's exact analytic
// surface evaluation (GeomAPI_IntCS for intersection, GeomLProp_SLProps for the normal) —
// never from a triangle. A pure-JS ray/bounding-box test is used only as a broad-phase
// filter to decide which faces are even worth an exact OCCT test; it never affects the
// optical result, only which faces get skipped before the expensive analytic call.
//
// OCCT WASM objects are not garbage collected. Every temporary created inside the hot
// per-ray-per-face loop is deleted before moving on; only the face table's long-lived
// handles (surface, classifier, trsfFwd/trsfInv) survive across calls.

import * as THREE from 'three';
import { computeBounce, wavelengthToRGB, cosineWeightedHemisphereDirection, randomIsotropicDirection } from './optics.js';
import { sumBandsClamped, sampleEmissionWavelength } from './spectralBands.js';

const MAX_SEGMENTS = 60000; // B-rep intersection is far slower than a triangle BVH —
                             // keep the per-trace budget modest (see DEVELOPMENT_SPEC §7).

// Ray vs. axis-aligned bounding box (slab method), padded by `pad` on every side.
function rayHitsBox(ox, oy, oz, dx, dy, dz, box, pad) {
  let tmin = -Infinity, tmax = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let i = 0; i < 3; i++) {
    const lo = box.min[i] - pad, hi = box.max[i] + pad;
    if (Math.abs(d[i]) < 1e-14) {
      if (o[i] < lo || o[i] > hi) return false;
      continue;
    }
    let t1 = (lo - o[i]) / d[i];
    let t2 = (hi - o[i]) / d[i];
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return tmax >= 0;
}

/**
 * Exact analytic intersection of a world-space ray against one B-rep face.
 * @returns {{ dist:number, point:THREE.Vector3, normal:THREE.Vector3 } | null}
 */
function intersectFace(oc, f, origin, dir, eps) {
  // move the ray into the face's local (untransformed-surface) frame
  const worldPnt = new oc.gp_Pnt_3(origin.x, origin.y, origin.z);
  const worldDir = new oc.gp_Dir_4(dir.x, dir.y, dir.z);
  const localPnt = worldPnt.Transformed(f.trsfInv);
  const localDir = worldDir.Transformed(f.trsfInv);
  worldPnt.delete(); worldDir.delete();

  const line = new oc.Geom_Line_3(localPnt, localDir);
  localPnt.delete(); localDir.delete();
  const lineHandle = new oc.Handle_Geom_Curve_2(line);
  // NOTE: Handle_Geom_Curve takes ownership of `line` (OCCT Handle<T> is a refcounted
  // smart pointer) — once wrapped, only `lineHandle.delete()` may be called. Calling
  // `line.delete()` too is a double-free: it doesn't crash immediately (the first few
  // hundred calls "work"), it corrupts the WASM dynamic-linking function table and
  // crashes later with an opaque "null function or function signature mismatch" /
  // "table index out of bounds" — do not reintroduce it.

  const intCS = new oc.GeomAPI_IntCS_2(lineHandle, f.surface);

  let best = null;
  if (intCS.IsDone()) {
    const n = intCS.NbPoints();
    const uOut = { current: 0 }, vOut = { current: 0 }, wOut = { current: 0 };
    for (let i = 1; i <= n; i++) {
      intCS.Parameters_1(i, uOut, vOut, wOut);
      const dist = wOut.current;
      if (dist <= eps) continue; // behind the ray origin, or the surface we just left
      if (best && dist >= best.dist) continue;

      const uv = new oc.gp_Pnt2d_3(uOut.current, vOut.current);
      const state = f.classifier.Perform(uv, 1e-7);
      uv.delete();
      const onFace = state === oc.TopAbs_State.TopAbs_IN || state === oc.TopAbs_State.TopAbs_ON;
      if (!onFace) continue;

      const props = new oc.GeomLProp_SLProps_1(f.surface, uOut.current, vOut.current, 1, 1e-7);
      if (!props.IsNormalDefined()) { props.delete(); continue; }
      const localNormal = props.Normal();
      props.delete();
      const worldNormal = localNormal.Transformed(f.trsfFwd);
      localNormal.delete();

      const localPoint = intCS.Point(i);
      const worldPoint = localPoint.Transformed(f.trsfFwd);
      localPoint.delete();

      best = {
        dist,
        point: new THREE.Vector3(worldPoint.X(), worldPoint.Y(), worldPoint.Z()),
        normal: new THREE.Vector3(worldNormal.X(), worldNormal.Y(), worldNormal.Z()).normalize(),
      };
      worldPoint.delete();
      worldNormal.delete();
    }
  }

  intCS.delete();
  lineHandle.delete(); // also frees the underlying `line` — see note above
  return best;
}

/**
 * @param faceTable   from occt.buildFaceTable()
 * @param getIor      (bodyId, wavelengthNm) => index of refraction of that body at
 *                    that wavelength — called with the ray's CURRENT wavelength, which
 *                    may differ from the trace's nominal `wavelength` after a phosphor
 *                    conversion changes it mid-flight.
 * @param getPhosphor (bodyId) => that body's material.phosphor, or null/undefined —
 *                    used for volumetric conversion while a ray's insideBodyId is set.
 * @param isBlocker   (bodyId) => true if that body's material is 'blocker' — absorbs
 *                    by default; a face-level reflectivity/dichroic override still
 *                    reflects its share, but the rest is absorbed, never transmitted.
 * @param params      { origin, directions, maxBounces, minIntensity, maxDist, eps, ambientIor, wavelength }
 *                    OR { rays: [{origin, dir, energy?}], ... } for multi-origin sources
 *                    (surface/whole-body emitters — each sample point is its own origin).
 * @returns { segments: [{a,b,energy,rgb}], mapHits: [{faceId,point,energy,wavelength}], stats }
 */
export function traceRaysBrep(oc, faceTable, getIor, getPhosphor, isBlocker, params) {
  const t0 = performance.now();
  const { maxBounces, minIntensity, maxDist, eps, wavelength } = params;
  const ambientIor = params.ambientIor ?? 1.0;
  const pad = Math.max(eps * 10, 1e-6);

  const segments = [];
  const mapHits = [];
  let capped = false;
  let maxDepthReached = 0;

  // `wavelength` is mutable per-ray (a phosphor conversion changes it mid-flight —
  // Phase 6/7); `insideBodyId` is the body whose interior this ray currently occupies
  // (null = ambient medium), tracked explicitly rather than re-derived per hit, since a
  // converted ray's re-emission direction can't be inferred from the old geometry alone.
  const stack = [];
  if (params.rays) {
    for (const r of params.rays) {
      stack.push({
        origin: r.origin.clone(), dir: r.dir.clone(), energy: r.energy ?? 1,
        depth: 0, wavelength, insideBodyId: null,
      });
    }
  } else {
    for (const dir of params.directions) {
      stack.push({
        origin: params.origin.clone(), dir: dir.clone(), energy: 1,
        depth: 0, wavelength, insideBodyId: null,
      });
    }
  }

  while (stack.length > 0) {
    if (segments.length >= MAX_SEGMENTS) { capped = true; break; }
    const ray = stack.pop();
    maxDepthReached = Math.max(maxDepthReached, ray.depth);

    const start = ray.origin.clone().addScaledVector(ray.dir, eps);

    let nearest = null;
    let nearestFace = null;
    for (const body of faceTable.bodies) {
      // a body converted to a light source is a source, not an optical element —
      // rays never intersect it, from this light or any other (see app.js's
      // convertBodyToLightSource)
      if (body.isLightSource) continue;
      // one cheap test skips this body's whole face list when the ray can't reach it —
      // matters for assemblies where parts are spread out (see occt.buildFaceTable)
      if (!rayHitsBox(start.x, start.y, start.z, ray.dir.x, ray.dir.y, ray.dir.z, body.bbox, pad)) continue;
      for (const faceId of body.faceIds) {
        const f = faceTable.faces[faceId];
        if (!rayHitsBox(start.x, start.y, start.z, ray.dir.x, ray.dir.y, ray.dir.z, f.bbox, pad)) continue;
        const hit = intersectFace(oc, f, start, ray.dir, eps);
        if (hit && (!nearest || hit.dist < nearest.dist)) {
          nearest = hit;
          nearestFace = f;
        }
      }
    }

    const rgb = wavelengthToRGB(ray.wavelength);

    // Volumetric phosphor: for a ray currently traveling inside a phosphor-enabled
    // body, this segment gets its own independent free-flight draw (inverse-CDF of
    // the exponential distribution). If the sampled absorption distance is shorter
    // than the distance to the next real surface hit (or escape), conversion happens
    // at that interior point instead — correctly making thicker paths convert more
    // (Beer-Lambert) with no need to track entry/exit pairs, since every segment
    // rolls independently and this applies just as well across internal TIR bounces.
    if (ray.insideBodyId !== null) {
      const phosphor = getPhosphor(ray.insideBodyId);
      if (phosphor) {
        const excitation = sumBandsClamped(phosphor.excitationBands, ray.wavelength);
        if (excitation > 0) {
          const mu = excitation / phosphor.conversionDepth;
          const freeFlight = -Math.log(1 - Math.random()) / mu;
          const hitDist = nearest ? nearest.dist : maxDist;
          if (freeFlight < hitDist) {
            const convertPoint = start.clone().addScaledVector(ray.dir, freeFlight);
            segments.push({ a: ray.origin, b: convertPoint, energy: ray.energy, rgb });
            if (ray.depth < maxBounces && ray.energy >= minIntensity) {
              stack.push({
                origin: convertPoint, dir: randomIsotropicDirection(),
                energy: ray.energy, depth: ray.depth + 1,
                wavelength: sampleEmissionWavelength(phosphor.emissionBands),
                insideBodyId: ray.insideBodyId,
              });
            }
            continue;
          }
        }
      }
    }

    if (!nearest) {
      const end = start.clone().addScaledVector(ray.dir, maxDist);
      segments.push({ a: ray.origin, b: end, energy: ray.energy, rgb });
      continue;
    }

    segments.push({ a: ray.origin, b: nearest.point, energy: ray.energy, rgb });

    // A "Map" surface records every hit for the splat-heatmap visualization (see
    // app.js) independent of any other surface condition — mutually exclusive with
    // reflectivity/dichroic/phosphor in the face-mode dropdown, so nothing below this
    // needs to know about it. `block` (default true) absorbs the ray here; unblocked,
    // it's a "ghost" recording plane — the ray continues straight through unperturbed
    // (same direction/wavelength/medium), so several can be stacked and seen through.
    if (nearestFace.map) {
      mapHits.push({
        faceId: nearestFace.id, point: nearest.point.clone(), normal: nearest.normal.clone(),
        energy: ray.energy, wavelength: ray.wavelength,
      });
      if (!nearestFace.map.block && ray.depth < maxBounces && ray.energy >= minIntensity) {
        stack.push({
          origin: nearest.point.clone(), dir: ray.dir.clone(), energy: ray.energy,
          depth: ray.depth + 1, wavelength: ray.wavelength, insideBodyId: ray.insideBodyId,
        });
      }
      continue;
    }

    if (ray.depth >= maxBounces) continue;

    // orient the normal against the incoming ray; pick media accordingly
    const bodyIor = getIor(nearestFace.bodyId, ray.wavelength);
    let n1 = ambientIor, n2 = bodyIor;
    const leaving = nearest.normal.dot(ray.dir) > 0; // hit from the inside?
    const n = nearest.normal.clone();
    if (leaving) {
      n.negate();
      n1 = bodyIor; n2 = ambientIor;
    }

    // Surface phosphor: a flat per-hit conversion probability (no path-length
    // dependence — that's the volumetric body-phosphor model in the getIor/body loop
    // below instead). On success this ray is fully consumed here — a new ray at a
    // resampled emission wavelength takes over, re-emitted diffusely (Lambertian) back
    // into the hemisphere the incoming ray arrived from — and the normal R/T split is
    // skipped entirely for this hit.
    if (nearestFace.phosphor) {
      const excitation = sumBandsClamped(nearestFace.phosphor.excitationBands, ray.wavelength);
      const convertProbability = excitation * nearestFace.phosphor.efficiency;
      if (Math.random() < convertProbability) {
        const newWavelength = sampleEmissionWavelength(nearestFace.phosphor.emissionBands);
        if (ray.energy >= minIntensity) {
          stack.push({
            origin: nearest.point.clone(),
            dir: cosineWeightedHemisphereDirection(n),
            energy: ray.energy,
            depth: ray.depth + 1,
            wavelength: newWavelength,
            insideBodyId: ray.insideBodyId,
          });
        }
        continue;
      }
    }

    // a dichroic coating overrides the Fresnel/fixed reflectivity choice with a
    // wavelength-dependent value computed from its reflect bands (see spectralBands.js).
    // A blocker body with no face override (Auto/Fresnel mode, reflectivity === null)
    // is fully absorbing by default — 0, not the physical Fresnel value, since a
    // blocker has no meaningful IOR to reflect off of. An explicit override (fixed
    // reflectivity or dichroic) still applies normally for the reflected share.
    const bodyIsBlocker = isBlocker(nearestFace.bodyId);
    const effectiveReflectivity = nearestFace.dichroic
      ? sumBandsClamped(nearestFace.dichroic.bands, ray.wavelength)
      : (nearestFace.reflectivity !== null ? nearestFace.reflectivity : (bodyIsBlocker ? 0 : null));

    const { reflectDir, refractDir, R, tir } = computeBounce(
      ray.dir, n, n1, n2, effectiveReflectivity);

    const reflectedEnergy = ray.energy * R;
    const refractedEnergy = ray.energy * (1 - R);

    // reflection never crosses the boundary — same medium as the incoming ray;
    // refraction always does — entering sets insideBodyId to this body, leaving
    // clears it back to the ambient medium. A blocker never transmits: whatever isn't
    // reflected here is absorbed, not refracted (e.g. a 50% mirror on a blocker body
    // reflects 50% and absorbs 50%, per the material's whole purpose).
    if (reflectedEnergy >= minIntensity) {
      stack.push({
        origin: nearest.point.clone(), dir: reflectDir, energy: reflectedEnergy,
        depth: ray.depth + 1, wavelength: ray.wavelength, insideBodyId: ray.insideBodyId,
      });
    }
    if (!tir && !bodyIsBlocker && refractedEnergy >= minIntensity) {
      stack.push({
        origin: nearest.point.clone(), dir: refractDir, energy: refractedEnergy,
        depth: ray.depth + 1, wavelength: ray.wavelength,
        insideBodyId: leaving ? null : nearestFace.bodyId,
      });
    }
  }

  return {
    segments,
    mapHits,
    stats: {
      raysEmitted: params.rays ? params.rays.length : params.directions.length,
      segments: segments.length,
      maxDepthReached,
      capped,
      timeMs: performance.now() - t0,
    },
  };
}
