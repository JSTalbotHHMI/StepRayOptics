// Light source data model: point lights and (Phase 2) body-based emitters.
//
// A LightSource is a plain data object holding its own full configuration
// (wavelength/spectrum, intensity, ray count, emission mode, cone angle, optional
// angular profile). app.js owns the paired THREE.Object3D (position/rotation/visual
// markers) for each light and renders one UI card per entry, mirroring the existing
// Bodies-list / buildMaterialUI pattern.
//
// `lightMode` is one of:
//   'single'   — one exact wavelength, no spread.
//   'gaussian' — a smooth peak around `wavelength` (its center) with `bandwidth` (FWHM,
//                nm) — a single real LED/laser line, reusing spectralBands.js's Gaussian
//                band math already used for dichroics/phosphors.
//   'spectrum' ("Custom Spectrum" in the UI) — a hand-drawn wavelength-vs-intensity
//                curve (`spectralProfile`, see angularProfile.js — the same curve editor
//                as the angular profile, just plotted against wavelength instead of
//                angle) sampled across [specMin, specMax].
// Internal value stays 'spectrum' (not renamed to e.g. 'custom') so saved
// settings/materials from before this mode was reworked still select the right radio.

import { gaussianWeight } from './spectralBands.js';
import { sampleProfile } from './angularProfile.js';

let nextLightId = 1;

export function rayCountFromSlider(s) {
  return Math.round(10 * Math.pow(2000, s / 100)); // 10 .. 20,000 (log scale)
}

function baseLightFields() {
  return {
    lightMode: 'single',       // 'single' | 'gaussian' | 'spectrum'
    wavelength: 550,            // exact wavelength ('single'), or center ('gaussian')
    bandwidth: 40,               // FWHM, nm — 'gaussian' only
    specMin: 400, specMax: 700, specSamples: 10, // 'spectrum' domain + sample count
    spectralProfile: null,       // 'spectrum' only: { points: [{x, intensity}, ...] }
    intensity: 0.05,
    raySlider: 55,              // slider position 0..100 — see rayCountFromSlider
    emissionMode: 'cone',        // 'sphere' | 'cone' | 'custom'
    coneAngle: 20,
    angularProfile: null,        // { points: [{x, intensity}, ...] } over a fixed 0-90° domain
  };
}

export function createPointLight() {
  return {
    id: nextLightId++,
    kind: 'point',
    isDefault: false,
    name: null, // null = auto-generate a display name from kind/index
    ...baseLightFields(),
  };
}

export function createDefaultPointLight() {
  const light = createPointLight();
  light.isDefault = true;
  return light;
}

/**
 * A body-based emitter. `subMode` selects how the body generates light:
 *   'point'    — behaves exactly like a point light, positioned at the body's true
 *                volumetric centroid (see occt.computeBodyCentroid); the position can
 *                still be dragged/rotated afterward like any point light.
 *   'surfaces' — user-selected faces on the body emit (see `selectedFaceIds`).
 *   'body'     — every face of the body emits.
 * For 'surfaces'/'body', `surfaceEmission` chooses between emitting exactly along each
 * sampled point's outward normal ('normal') or within a cone up to `surfaceMaxAngle`
 * degrees from it ('maxAngle') — no single position/rotation gizmo applies to either,
 * since emission comes from many points across the body, each with its own normal.
 */
export function createBodyLight(bodyId, subMode) {
  return {
    id: nextLightId++,
    kind: 'body',
    isDefault: false,
    name: null,
    bodyId,
    subMode: subMode || 'point',       // 'point' | 'surfaces' | 'body'
    surfaceEmission: 'normal',          // 'normal' | 'maxAngle'
    surfaceMaxAngle: 30,
    selectedFaceIds: new Set(),         // used when subMode === 'surfaces'
    ...baseLightFields(),
  };
}

/**
 * Enforces the default-light rule: a lone auto-created point light exists only when
 * no other light sources are configured. It is removed the moment any other light
 * (a user-added point light, or a body-based emitter) becomes active, and re-added if
 * the list ever empties back out. Returns the (possibly new) array to use.
 */
export function reconcileDefaultLights(lights) {
  const real = lights.filter((l) => !l.isDefault);
  if (real.length === 0) {
    if (lights.length === 0) return [createDefaultPointLight()];
    return lights; // already just the default light — leave it
  }
  return real;
}

export function lightDisplayName(light, index, bodyName) {
  if (light.name) return light.name;
  if (light.kind === 'point') {
    return light.isDefault ? 'Point Light (default)' : `Point Light ${index + 1}`;
  }
  return bodyName ? `${bodyName} Light` : `Body ${light.bodyId + 1} Light`;
}

// Wavelengths to trace for one light, one {wavelength, weight} entry per spectral
// sample — `weight` (0..1) is an energy multiplier applied on top of the light's own
// gain (see app.js's trace()), the same "dim, don't drop" treatment angularProfile.js
// already uses for angle. 'single' is the trivial one-sample, full-weight case.
export function traceWavelengths(light) {
  if (light.lightMode === 'gaussian') {
    const bw = Math.max(1, light.bandwidth);
    const lo = Math.max(380, light.wavelength - 2 * bw);
    const hi = Math.min(750, light.wavelength + 2 * bw);
    const n = Math.max(1, Math.round(light.specSamples));
    const list = [];
    for (let i = 0; i < n; i++) {
      const wavelength = lo + (hi - lo) * (n === 1 ? 0.5 : i / (n - 1));
      list.push({ wavelength, weight: gaussianWeight(light.wavelength, bw, wavelength) });
    }
    return list;
  }

  if (light.lightMode === 'spectrum') {
    const lo = Math.min(light.specMin, light.specMax);
    const hi = Math.max(light.specMin, light.specMax);
    const n = Math.max(1, Math.round(light.specSamples));
    const list = [];
    for (let i = 0; i < n; i++) {
      const wavelength = lo + (hi - lo) * (n === 1 ? 0.5 : i / (n - 1));
      list.push({ wavelength, weight: sampleProfile(light.spectralProfile, wavelength) });
    }
    return list;
  }

  return [{ wavelength: light.wavelength, weight: 1 }];
}

export function centerWavelength(light) {
  if (light.lightMode === 'spectrum') return (light.specMin + light.specMax) / 2;
  return light.wavelength; // 'single' exact value, 'gaussian' center — same field either way
}
