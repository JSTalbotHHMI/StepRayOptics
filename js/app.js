import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { initOcct, readStepFromUrl, buildFaceTable, buildDisplayMeshes, disposeFaceTable, sampleFacePoints, describeException } from './occt.js';
import { traceRaysBrep } from './brepTracer.js';
import { emissionDirections, randomConeDirection, profileWeightedDirection, wavelengthToRGB, buildRayLines } from './optics.js';
import { iorAt, defaultMaterial, PRESETS, TYPE_FIELDS } from './materials.js';
import {
  createPointLight, createBodyLight, reconcileDefaultLights, lightDisplayName,
  rayCountFromSlider, traceWavelengths, centerWavelength,
} from './lights.js';
import { defaultProfile, createProfileEditor, buildAngleSampler } from './angularProfile.js';
import { defaultBand, defaultPhosphorConfig, defaultVolumePhosphorConfig, createBandListEditor } from './spectralBands.js';
import { makeSceneModel, makeDemoPrismShape, makeDemoSphereShape } from './sceneModel.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');

// ------------------------------------------------------------ renderer/scene

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e12);

const camera = new THREE.PerspectiveCamera(
  50, viewport.clientWidth / viewport.clientHeight, 0.1, 100000
);
camera.position.set(80, 60, 80);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.1;

scene.add(new THREE.HemisphereLight(0x8899aa, 0x223344, 0.9));
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(100, 150, 80);
scene.add(keyLight);

const grid = new THREE.GridHelper(200, 40, 0x334455, 0x1e2630);
scene.add(grid);
const axes = new THREE.AxesHelper(20);
scene.add(axes);

// ------------------------------------------------------------- light sources
//
// `lights` holds plain LightSource data objects (see lights.js). `lightObjects` pairs
// each light's id with its THREE.Object3D representation. Position is the object's own
// position; "custom aim" direction is its own local -Z axis (rotation-based aim — a
// small arrow child mesh makes the current facing visible).

let lights = [];
const lightObjects = new Map(); // id -> { group, marker, glow, arrow }

// Personal material library — name -> material, persisted in localStorage (this is a
// standalone sandbox with no host application to store it for us, unlike
// InventorRayOptics' C#-backed per-machine library). See loadMaterialLibrary/
// saveMaterialLibrary below.
let materialLibrary = {};
const MATERIAL_LIBRARY_KEY = 'steprayoptics.materialLibrary';

function loadMaterialLibrary() {
  try {
    materialLibrary = JSON.parse(localStorage.getItem(MATERIAL_LIBRARY_KEY) || '{}');
  } catch {
    materialLibrary = {};
  }
}
function saveMaterialLibraryEntry(name, material) {
  materialLibrary[name] = material;
  localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(materialLibrary));
}
function deleteMaterialLibraryEntry(name) {
  delete materialLibrary[name];
  localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(materialLibrary));
}

const lightGizmo = new TransformControls(camera, renderer.domElement);
lightGizmo.setSize(0.8);
scene.add(lightGizmo);
let activeLightId = null;
lightGizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
lightGizmo.addEventListener('objectChange', () => {
  rebuildLightList(); // cheap enough; keeps position/rotation readouts live while dragging
  requestTrace();
});

function makeLightObject(light) {
  const group = new THREE.Group();
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(1, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffcc })
  );
  const glow = new THREE.PointLight(0xffffff, 0, 400);
  // forward-facing indicator (local -Z) — makes the rotate gizmo's aim direction visible
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.35, 1.4, 12),
    new THREE.MeshBasicMaterial({ color: 0xff8844 })
  );
  arrow.rotation.x = -Math.PI / 2; // cone's own +Y axis -> local -Z
  arrow.position.z = -1.4;
  group.add(marker, glow, arrow);
  return { group, marker, glow, arrow };
}

// reconcileDefaultLights can introduce a brand-new default light object (e.g. when
// the list empties out) without anyone creating its THREE representation — make sure
// every light in `lights` has one before anything tries to render/list them.
function ensureLightObjects() {
  for (const light of lights) {
    if (lightObjects.has(light.id)) continue;
    const obj = makeLightObject(light);
    obj.group.position.copy(modelCenter()).add(new THREE.Vector3(50, 10, 0));
    lightObjects.set(light.id, obj);
    scene.add(obj.group);
  }
}

function addLight(light, position) {
  lights.push(light);
  const obj = makeLightObject(light);
  if (position) obj.group.position.copy(position);
  else obj.group.position.set(50, 10, 0);
  lightObjects.set(light.id, obj);
  scene.add(obj.group);
  lights = reconcileDefaultLights(lights);
  pruneOrphanedLightObjects();
  ensureLightObjects();
  rebuildLightList();
  updateSceneScale();
  requestTrace();
}

function removeLight(lightId) {
  const idx = lights.findIndex((l) => l.id === lightId);
  if (idx < 0) return;
  lights.splice(idx, 1);
  const obj = lightObjects.get(lightId);
  if (obj) {
    if (activeLightId === lightId) { lightGizmo.detach(); activeLightId = null; }
    scene.remove(obj.group);
    lightObjects.delete(lightId);
  }
  lights = reconcileDefaultLights(lights);
  ensureLightObjects();
  rebuildLightList();
  updateSceneScale();
  requestTrace();
}

// reconcileDefaultLights can replace the array wholesale (e.g. dropping the default
// light) without touching lightObjects — sweep away anything no longer referenced.
function pruneOrphanedLightObjects() {
  const liveIds = new Set(lights.map((l) => l.id));
  for (const [id, obj] of lightObjects) {
    if (!liveIds.has(id)) {
      if (activeLightId === id) { lightGizmo.detach(); activeLightId = null; }
      scene.remove(obj.group);
      lightObjects.delete(id);
    }
  }
}

function setLightTransformMode(light, mode) {
  const obj = lightObjects.get(light.id);
  if (!obj) return;
  if (activeLightId === light.id && lightGizmo.mode === mode) {
    lightGizmo.detach();
    activeLightId = null;
  } else {
    activeLightId = light.id;
    lightGizmo.setMode(mode);
    lightGizmo.attach(obj.group);
  }
  rebuildLightList();
  updateWidgetVisibility();
}

// single place that decides which control widgets are visible; the master
// "Show control widgets" toggle overrides the individual checkboxes
function updateWidgetVisibility() {
  const master = $('show-widgets').checked;
  const on = master && activeLightId !== null;
  lightGizmo.visible = on;
  lightGizmo.enabled = on;
  for (const obj of lightObjects.values()) {
    obj.marker.visible = master;
    obj.arrow.visible = master;
  }
}

// ------------------------------------------------------------------- state

let oc = null;             // OpenCascade instance (loaded once, lazily on first model add)
let sceneModel = null;      // makeSceneModel(oc) — tracks independently-loaded/removable solids
let faceTable = null;       // { faces, bodies } for the CURRENT merged compound of every
                             // loaded solid — rebuilt (not incrementally updated) on every
                             // add/remove, since occt.js's pipeline always targets one shape.
                             // See rebuildFaceTableFromSceneModel for how per-body/per-face
                             // customization survives that rebuild regardless.
let currentCompound = null; // the TopoDS_Compound faceTable's long-lived analytic handles
                             // reference — kept alive exactly as long as faceTable itself
                             // (same pattern InventorRayOptics uses for its single `shape`),
                             // not deleted until the NEXT rebuild replaces it.
const faceMeshes = new Map(); // faceId -> THREE.Mesh (display only)
let modelGroup = new THREE.Group();
scene.add(modelGroup);

let rayLines = null;      // current LineSegments of traced rays
let selectedFaceId = null;
let sceneDiag = 100;      // bounding diagonal, drives ray length / epsilon

// while non-null, clicking a face toggles its membership in that body-light's
// selectedFaceIds instead of the normal reflectivity-selection flow (see
// buildLightUI's "Select Emitting Surfaces" toggle and the pointerup handler below)
let emitterSelectionLightId = null;

const NORMAL_MATERIAL = new THREE.MeshStandardMaterial({
  color: 0x7fb8d8, metalness: 0.05, roughness: 0.25,
  transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false,
});
const HIGHLIGHT_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xffaa33, side: THREE.DoubleSide, transparent: true, opacity: 0.55,
  depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
});
const EMITTER_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xfff2b0, side: THREE.DoubleSide, transparent: true, opacity: 0.6,
  depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
});

// Recomputes which face meshes should show the warm "this surface emits light"
// overlay, from every body-light currently configured as 'surfaces' or 'body'.
function refreshEmitterHighlights() {
  const emittingFaceIds = new Set();
  for (const light of lights) {
    if (light.kind !== 'body') continue;
    if (light.subMode === 'body') {
      const body = faceTable?.bodies?.find((b) => b.id === light.bodyId);
      body?.faceIds.forEach((id) => emittingFaceIds.add(id));
    } else if (light.subMode === 'surfaces') {
      light.selectedFaceIds.forEach((id) => emittingFaceIds.add(id));
    }
  }
  for (const [faceId, mesh] of faceMeshes) {
    if (faceId === selectedFaceId) continue; // reflectivity selection wins visually
    mesh.material = emittingFaceIds.has(faceId) ? EMITTER_MATERIAL : NORMAL_MATERIAL;
  }
}

// --------------------------------------------------------------- UI helpers

// A left-to-right hue gradient across [lo, hi] nm — used for both the "Custom Spectrum"
// and "Wavelength + bandwidth" swatches. Hue only (unweighted by any curve/Gaussian
// shape) — same simplicity as the swatch this replaces.
function spectrumGradientCss(lo, hi) {
  const stops = [];
  for (let i = 0; i <= 10; i++) {
    stops.push(`${cssColor(wavelengthToRGB(lo + (hi - lo) * (i / 10)))} ${i * 10}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

function cssColor(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

function tracingParams() {
  return {
    maxBounces: Number($('max-bounces').value),
    minIntensity: Number($('min-intensity').value),
    ambientIor: Math.max(1, Number($('ambient-ior').value) || 1),
  };
}

function refreshValueLabels() {
  $('max-bounces-val').textContent = $('max-bounces').value;
  $('min-intensity-val').textContent = Number($('min-intensity').value).toFixed(3);
  updateWidgetVisibility();
  updateIorHints();
}

function updateIorHints() {
  if (!faceTable) return;
  for (const el of document.querySelectorAll('#body-list .n-hint')) {
    const body = faceTable.bodies.find((b) => String(b.id) === el.dataset.bodyId);
    // representative wavelength for the hint: center of the first enabled light,
    // or 550nm if there are none
    const wl = lights.length > 0 ? centerWavelength(lights[0]) : 550;
    const ambientIor = Math.max(1, Number($('ambient-ior').value) || 1);
    if (body) el.textContent = `n(${Math.round(wl)} nm) = ${iorAt(body.material, wl, ambientIor).toFixed(4)}`;
  }
}

function modelCenter() {
  if (faceMeshes.size === 0) return new THREE.Vector3(0, 0, 0);
  const box = new THREE.Box3().setFromObject(modelGroup);
  return box.getCenter(new THREE.Vector3());
}

function updateSceneScale() {
  // Model-only diagonal — the fallback for a light indicator's own size when there's no
  // more specific body to size against (a plain point light, or a body light whose body
  // no longer exists). No absolute-unit floor here (unlike sceneDiag below) — a floor
  // silently overpowers proportionality for any small real part.
  const modelBox = new THREE.Box3().setFromObject(modelGroup);
  const modelDiag = modelBox.isEmpty() ? 100 : Math.max(modelBox.getSize(new THREE.Vector3()).length(), 1e-6);

  const box = modelBox.clone();
  for (const obj of lightObjects.values()) box.expandByPoint(obj.group.position);
  sceneDiag = box.isEmpty() ? 100 : Math.max(box.getSize(new THREE.Vector3()).length(), 10);

  // A body light's indicator sizes against its OWN body's diagonal, not the whole
  // model's — several small bodies spaced far apart have a huge combined model
  // diagonal (dominated by the spacing, not any one body's actual size).
  for (const light of lights) {
    const obj = lightObjects.get(light.id);
    if (!obj) continue;
    let indicatorDiag = modelDiag;
    const body = light.kind === 'body' ? faceTable?.bodies?.find((b) => b.id === light.bodyId) : null;
    if (body?.bbox) {
      const dx = body.bbox.max[0] - body.bbox.min[0];
      const dy = body.bbox.max[1] - body.bbox.min[1];
      const dz = body.bbox.max[2] - body.bbox.min[2];
      indicatorDiag = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    }
    obj.marker.scale.setScalar(Math.max(indicatorDiag * 0.008, 1e-4));
    obj.arrow.scale.setScalar(Math.max(indicatorDiag * 0.012, 1e-4));
  }
}

function fitView() {
  updateSceneScale();
  const center = faceMeshes.size > 0 ? modelCenter()
    : (lightObjects.size > 0 ? [...lightObjects.values()][0].group.position.clone() : new THREE.Vector3());
  const dist = sceneDiag * 1.2;
  orbit.target.copy(center);
  const dir = camera.position.clone().sub(orbit.target).normalize();
  if (!isFinite(dir.length()) || dir.length() === 0) dir.set(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
}

// -------------------------------------------------------------- light list

const ANGULAR_PROFILE_MAX_DEG = 90;

// Appends the "Angular Profile" checkbox + curve editor to `container` (some section
// of a light card), rebuilding the whole card (`cardContainer`, the light-item div
// passed all the way down from rebuildLightList) on toggle. Only meaningful where rays
// actually spread across a range of angles — point-like sources, and surface/body
// emitters in "max angle from normal" mode — a profile has no visible effect when
// every ray goes exactly along one direction.
//
// The curve's domain is always a fixed 0-90°, independent of the light's own cone-angle/
// max-angle slider — those sliders stop constraining ray generation entirely once a
// profile is active (see trace()/generateBodyEmissionRays), so their value has no
// meaning here and the caller hides them while a profile is active.
function appendAngularProfileSection(light, container, cardContainer) {
  const toggleRow = document.createElement('label');
  toggleRow.className = 'check';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!light.angularProfile;
  toggleRow.append(toggle, document.createTextNode(' Custom angular profile'));
  container.appendChild(toggleRow);

  if (light.angularProfile) {
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Cone/max angle above no longer applies — this curve\'s 0-90° range now controls the emission spread.';
    container.appendChild(hint);

    const editor = createProfileEditor(
      light.angularProfile, 0, ANGULAR_PROFILE_MAX_DEG, () => requestTrace(),
      { formatX: (v) => `${Math.round(v)}°` }
    );
    container.appendChild(editor.element);
  }

  toggle.addEventListener('change', () => {
    light.angularProfile = toggle.checked ? defaultProfile(0, ANGULAR_PROFILE_MAX_DEG) : null;
    buildLightUI(light, cardContainer);
    requestTrace();
  });
}

// Shared "Samples" slider for both spectral modes that trace more than one wavelength
// ('gaussian' and 'spectrum') — how many discrete wavelengths to actually ray-trace
// within the mode's effective range.
function appendSpectralSamplesRow(light, container) {
  const samplesRow = document.createElement('div');
  samplesRow.className = 'slider-row';
  const samplesLabel = document.createElement('span');
  samplesLabel.textContent = 'Samples';
  const samples = document.createElement('input');
  samples.type = 'range'; samples.min = 2; samples.max = 24; samples.step = 1; samples.value = light.specSamples;
  const samplesVal = document.createElement('span');
  samplesVal.className = 'val';
  samplesVal.textContent = light.specSamples;
  samples.addEventListener('input', () => {
    light.specSamples = Number(samples.value);
    samplesVal.textContent = light.specSamples;
    requestTrace();
  });
  samplesRow.append(samplesLabel, samples, samplesVal);
  container.appendChild(samplesRow);
}

// Emission shape for a single-origin fan — a plain point light, or a body light in
// 'point' (centroid) submode, which behaves exactly like one (see lights.js). Shared by
// both call sites so this isn't duplicated, and rendered in one place per light.
function appendPointEmissionSection(light, container, cardContainer) {
  const emissionRow = document.createElement('div');
  emissionRow.className = 'slider-row';
  const emissionLabel = document.createElement('span');
  emissionLabel.textContent = 'Emission';
  const emissionSelect = document.createElement('select');
  emissionSelect.add(new Option('Full sphere', 'sphere'));
  emissionSelect.add(new Option('Cone (aimed at model)', 'cone'));
  emissionSelect.add(new Option('Cone (custom aim)', 'custom'));
  emissionSelect.value = light.emissionMode;
  emissionSelect.addEventListener('change', () => {
    light.emissionMode = emissionSelect.value;
    buildLightUI(light, cardContainer);
    requestTrace();
  });
  emissionRow.append(emissionLabel, emissionSelect);
  container.appendChild(emissionRow);

  if (light.emissionMode !== 'sphere') {
    if (!light.angularProfile) {
      const coneRow = document.createElement('div');
      coneRow.className = 'slider-row';
      const coneLabel = document.createElement('span');
      coneLabel.textContent = 'Cone angle';
      const coneSlider = document.createElement('input');
      coneSlider.type = 'range'; coneSlider.min = 1; coneSlider.max = 90; coneSlider.step = 1;
      coneSlider.value = light.coneAngle;
      const coneVal = document.createElement('span');
      coneVal.className = 'val';
      coneVal.textContent = `${light.coneAngle}°`;
      coneSlider.addEventListener('input', () => {
        light.coneAngle = Number(coneSlider.value);
        coneVal.textContent = `${light.coneAngle}°`;
        requestTrace();
      });
      coneRow.append(coneLabel, coneSlider, coneVal);
      container.appendChild(coneRow);
    }

    appendAngularProfileSection(light, container, cardContainer);
  }

  if (light.emissionMode === 'custom') {
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Aim direction follows this light’s own rotation — use the Rotate gizmo above (orange arrow shows the current aim).';
    container.appendChild(hint);
  }
}

function buildBodyLightUI(light, container) {
  const sub = document.createElement('div');
  sub.className = 'sub-section';

  const subModeRow = document.createElement('div');
  subModeRow.className = 'slider-row';
  const subModeLabel = document.createElement('span');
  subModeLabel.textContent = 'Emits from';
  const subModeSelect = document.createElement('select');
  subModeSelect.add(new Option('Point (body centroid)', 'point'));
  subModeSelect.add(new Option('Selected surfaces', 'surfaces'));
  subModeSelect.add(new Option('Whole body', 'body'));
  subModeSelect.value = light.subMode;
  subModeSelect.addEventListener('change', () => {
    if (light.subMode === 'surfaces' && emitterSelectionLightId === light.id) {
      emitterSelectionLightId = null;
    }
    light.subMode = subModeSelect.value;
    if (light.subMode !== 'point' && activeLightId === light.id) {
      lightGizmo.detach();
      activeLightId = null;
    }
    refreshEmitterHighlights();
    rebuildLightList();
    requestTrace();
  });
  subModeRow.append(subModeLabel, subModeSelect);
  sub.appendChild(subModeRow);

  if (light.subMode === 'point') {
    appendPointEmissionSection(light, sub, container);
  } else if (light.subMode === 'body') {
    // "Whole body" only supports normal emission — no cone/profile choice, since every
    // point across the whole body already emits along its own analytic surface normal.
    light.surfaceEmission = 'normal';
    light.angularProfile = null;
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = 'Emission: Normal — every point across the body emits along its own surface normal.';
    sub.appendChild(note);
  } else if (light.subMode === 'surfaces') {
    // "Selected surfaces" merges direction + custom-profile into one exclusive Emission
    // dropdown instead: Normal (default) / Angle from Normal (the max-angle slider) /
    // Custom Profile (the curve editor, no slider) — mutually exclusive.
    const emissionRow = document.createElement('div');
    emissionRow.className = 'slider-row';
    const emissionLabel = document.createElement('span');
    emissionLabel.textContent = 'Emission';
    const emissionSelect = document.createElement('select');
    emissionSelect.add(new Option('Normal', 'normal'));
    emissionSelect.add(new Option('Angle from Normal', 'maxAngle'));
    emissionSelect.add(new Option('Custom Profile', 'profile'));
    emissionSelect.value = light.surfaceEmission;
    emissionSelect.addEventListener('change', () => {
      light.surfaceEmission = emissionSelect.value;
      light.angularProfile = light.surfaceEmission === 'profile'
        ? (light.angularProfile || defaultProfile(0, ANGULAR_PROFILE_MAX_DEG))
        : null;
      buildLightUI(light, container);
      requestTrace();
    });
    emissionRow.append(emissionLabel, emissionSelect);
    sub.appendChild(emissionRow);

    if (light.surfaceEmission === 'maxAngle') {
      const angleRow = document.createElement('div');
      angleRow.className = 'slider-row';
      const angleLabel = document.createElement('span');
      angleLabel.textContent = 'Max angle';
      const angleSlider = document.createElement('input');
      angleSlider.type = 'range'; angleSlider.min = 1; angleSlider.max = 90; angleSlider.step = 1;
      angleSlider.value = light.surfaceMaxAngle;
      const angleVal = document.createElement('span');
      angleVal.className = 'val';
      angleVal.textContent = `${light.surfaceMaxAngle}°`;
      angleSlider.addEventListener('input', () => {
        light.surfaceMaxAngle = Number(angleSlider.value);
        angleVal.textContent = `${light.surfaceMaxAngle}°`;
        requestTrace();
      });
      angleRow.append(angleLabel, angleSlider, angleVal);
      sub.appendChild(angleRow);
    } else if (light.surfaceEmission === 'profile') {
      const editor = createProfileEditor(
        light.angularProfile, 0, ANGULAR_PROFILE_MAX_DEG, () => requestTrace(),
        { formatX: (v) => `${Math.round(v)}°` }
      );
      sub.appendChild(editor.element);
    }
  }

  if (light.subMode === 'surfaces') {
    const selectRow = document.createElement('div');
    selectRow.className = 'row';
    const selectBtn = document.createElement('button');
    const active = emitterSelectionLightId === light.id;
    selectBtn.textContent = active ? 'Done selecting' : 'Select Emitting Surfaces';
    if (active) selectBtn.classList.add('active');
    selectBtn.addEventListener('click', () => {
      emitterSelectionLightId = active ? null : light.id;
      rebuildLightList();
    });
    selectRow.appendChild(selectBtn);
    sub.appendChild(selectRow);

    const count = document.createElement('div');
    count.className = 'muted small';
    count.textContent = `${light.selectedFaceIds.size} surface(s) selected` +
      (active ? ' — click surfaces in the 3D view to toggle them' : '');
    sub.appendChild(count);
  }

  container.appendChild(sub);
}

function buildLightUI(light, container) {
  container.innerHTML = '';
  const obj = lightObjects.get(light.id);
  const index = lights.indexOf(light);

  const header = document.createElement('div');
  header.className = 'light-header';
  const swatch = document.createElement('span');
  swatch.className = 'light-swatch';
  swatch.style.background = cssColor(wavelengthToRGB(centerWavelength(light)));
  const name = document.createElement('span');
  name.className = 'light-name';
  const bodyName = light.kind === 'body' ? faceTable?.bodies?.find((b) => b.id === light.bodyId)?.name : null;
  name.textContent = lightDisplayName(light, index, bodyName);
  name.title = name.textContent;
  header.append(swatch, name);
  if (!light.isDefault) {
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'remove';
    del.addEventListener('click', () => removeLight(light.id));
    header.append(del);
  }
  container.appendChild(header);

  if (light.kind === 'body') {
    buildBodyLightUI(light, container);
  } else {
    appendPointEmissionSection(light, container, container);
  }

  // a single free position/rotation only makes sense for a point-like source — a
  // point light, or a body light in 'point' (centroid) submode. Surface/whole-body
  // emitters draw from many points across the body, each with its own normal.
  const isPointLike = light.kind === 'point' || light.subMode === 'point';
  if (isPointLike) {
    const xf = document.createElement('div');
    xf.className = 'xform-row';
    for (const [mode, text] of [['translate', 'Move'], ['rotate', 'Rotate']]) {
      const b = document.createElement('button');
      b.textContent = text;
      b.title = `Toggle ${text.toLowerCase()} gizmo for ${name.textContent}`;
      if (activeLightId === light.id && lightGizmo.mode === mode) b.classList.add('active');
      b.addEventListener('click', () => setLightTransformMode(light, mode));
      xf.appendChild(b);
    }
    container.appendChild(xf);

    const posRow = document.createElement('div');
    posRow.className = 'muted small';
    const p = obj.group.position;
    posRow.textContent = `Position: ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`;
    container.appendChild(posRow);
  }

  const modeRow = document.createElement('div');
  modeRow.className = 'slider-row';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = 'Light mode';
  const modeSelect = document.createElement('select');
  modeSelect.add(new Option('Single wavelength', 'single'));
  modeSelect.add(new Option('Wavelength + bandwidth', 'gaussian'));
  modeSelect.add(new Option('Custom Spectrum', 'spectrum'));
  modeSelect.value = light.lightMode;
  modeSelect.addEventListener('change', () => {
    light.lightMode = modeSelect.value;
    buildLightUI(light, container);
    requestTrace();
  });
  modeRow.append(modeLabel, modeSelect);
  container.appendChild(modeRow);

  if (light.lightMode === 'single') {
    const wlRow = document.createElement('div');
    wlRow.className = 'slider-row';
    const wlLabel = document.createElement('span');
    wlLabel.textContent = 'Wavelength';
    const wl = document.createElement('input');
    wl.type = 'range'; wl.min = 380; wl.max = 750; wl.step = 1; wl.value = light.wavelength;
    const wlVal = document.createElement('span');
    wlVal.className = 'val';
    const updateWl = () => { wlVal.textContent = `${wl.value} nm`; swatch.style.background = cssColor(wavelengthToRGB(Number(wl.value))); };
    wl.addEventListener('input', () => { light.wavelength = Number(wl.value); updateWl(); requestTrace(); });
    updateWl();
    wlRow.append(wlLabel, wl, wlVal);
    container.appendChild(wlRow);
  } else if (light.lightMode === 'gaussian') {
    const wlRow = document.createElement('div');
    wlRow.className = 'slider-row';
    const wlLabel = document.createElement('span');
    wlLabel.textContent = 'Center';
    const wl = document.createElement('input');
    wl.type = 'range'; wl.min = 380; wl.max = 750; wl.step = 1; wl.value = light.wavelength;
    const wlVal = document.createElement('span');
    wlVal.className = 'val';
    wlRow.append(wlLabel, wl, wlVal);
    container.appendChild(wlRow);

    const bwRow = document.createElement('div');
    bwRow.className = 'slider-row';
    const bwLabel = document.createElement('span');
    bwLabel.textContent = 'Bandwidth';
    const bw = document.createElement('input');
    bw.type = 'range'; bw.min = 1; bw.max = 200; bw.step = 1; bw.value = light.bandwidth;
    const bwVal = document.createElement('span');
    bwVal.className = 'val';
    bwRow.append(bwLabel, bw, bwVal);
    container.appendChild(bwRow);

    const gaussSwatchRow = document.createElement('div');
    gaussSwatchRow.className = 'swatch-row';
    gaussSwatchRow.textContent = 'Spectrum: ';
    const gaussSwatch = document.createElement('span');
    gaussSwatch.id = 'spec-swatch';
    gaussSwatchRow.appendChild(gaussSwatch);
    container.appendChild(gaussSwatchRow);

    const updateGaussian = () => {
      wlVal.textContent = `${wl.value} nm`;
      bwVal.textContent = `±${bw.value} nm`;
      swatch.style.background = cssColor(wavelengthToRGB(Number(wl.value)));
      const bwNum = Math.max(1, Number(bw.value));
      gaussSwatch.style.background = spectrumGradientCss(
        Number(wl.value) - 2 * bwNum, Number(wl.value) + 2 * bwNum
      );
    };
    wl.addEventListener('input', () => { light.wavelength = Number(wl.value); updateGaussian(); requestTrace(); });
    bw.addEventListener('input', () => { light.bandwidth = Number(bw.value); updateGaussian(); requestTrace(); });
    updateGaussian();

    appendSpectralSamplesRow(light, container);
  } else {
    const rangeRow = document.createElement('div');
    rangeRow.className = 'slider-row';
    const rangeLabel = document.createElement('span');
    rangeLabel.textContent = 'Range (nm)';
    const specMin = document.createElement('input');
    specMin.type = 'number'; specMin.className = 'nm'; specMin.min = 380; specMin.max = 750; specMin.step = 5;
    specMin.value = light.specMin;
    const dash = document.createElement('span'); dash.textContent = '–';
    const specMax = document.createElement('input');
    specMax.type = 'number'; specMax.className = 'nm'; specMax.min = 380; specMax.max = 750; specMax.step = 5;
    specMax.value = light.specMax;
    rangeRow.append(rangeLabel, specMin, dash, specMax);
    container.appendChild(rangeRow);

    appendSpectralSamplesRow(light, container);

    const specSwatchRow = document.createElement('div');
    specSwatchRow.className = 'swatch-row';
    specSwatchRow.textContent = 'Spectrum: ';
    const specSwatch = document.createElement('span');
    specSwatch.id = 'spec-swatch';
    specSwatch.style.background = spectrumGradientCss(light.specMin, light.specMax);
    specSwatchRow.appendChild(specSwatch);
    container.appendChild(specSwatchRow);

    if (!light.spectralProfile) light.spectralProfile = defaultProfile(light.specMin, light.specMax);
    const editor = createProfileEditor(
      light.spectralProfile, light.specMin, light.specMax, () => requestTrace(),
      { formatX: (v) => `${Math.round(v)}nm` }
    );
    container.appendChild(editor.element);

    // live-update the swatch + curve domain the moment the range extremes change,
    // without rebuilding the card (which would drop focus mid-keystroke)
    const updateRange = () => {
      light.specMin = Number(specMin.value) || light.specMin;
      light.specMax = Number(specMax.value) || light.specMax;
      specSwatch.style.background = spectrumGradientCss(light.specMin, light.specMax);
      editor.setRange(light.specMin, light.specMax);
      requestTrace();
    };
    specMin.addEventListener('input', updateRange);
    specMax.addEventListener('input', updateRange);
  }

  const intensityRow = document.createElement('div');
  intensityRow.className = 'slider-row';
  const intensityLabel = document.createElement('span');
  intensityLabel.textContent = 'Intensity';
  const intensitySlider = document.createElement('input');
  intensitySlider.type = 'range'; intensitySlider.min = 0; intensitySlider.max = 4; intensitySlider.step = 0.05;
  intensitySlider.value = light.intensity;
  const intensityNum = document.createElement('input');
  intensityNum.type = 'number'; intensityNum.className = 'val-input'; intensityNum.min = 0; intensityNum.step = 0.1;
  intensityNum.value = light.intensity;
  intensityNum.title = 'Type any value — the slider covers 0–4, but larger values are allowed';
  intensitySlider.addEventListener('input', () => {
    light.intensity = Number(intensitySlider.value);
    intensityNum.value = light.intensity.toFixed(2);
    requestTrace();
  });
  intensityNum.addEventListener('change', () => {
    light.intensity = Math.max(0, Number(intensityNum.value) || 0);
    intensityNum.value = light.intensity;
    intensitySlider.value = light.intensity; // clamps itself to the slider range
    requestTrace();
  });
  intensityRow.append(intensityLabel, intensitySlider, intensityNum);
  container.appendChild(intensityRow);

  const rayRow = document.createElement('div');
  rayRow.className = 'slider-row';
  const rayLabel = document.createElement('span');
  rayLabel.textContent = 'Ray count';
  const raySlider = document.createElement('input');
  raySlider.type = 'range'; raySlider.min = 0; raySlider.max = 100; raySlider.step = 1;
  raySlider.value = light.raySlider;
  const rayVal = document.createElement('span');
  rayVal.className = 'val';
  const updateRayVal = () => { rayVal.textContent = rayCountFromSlider(Number(raySlider.value)); };
  raySlider.addEventListener('input', () => { light.raySlider = Number(raySlider.value); updateRayVal(); requestTrace(); });
  updateRayVal();
  rayRow.append(rayLabel, raySlider, rayVal);
  container.appendChild(rayRow);
}

function rebuildLightList() {
  const list = $('light-list');
  list.innerHTML = '';
  if (lights.length === 0) {
    list.textContent = 'No light sources yet.';
    list.className = 'muted small';
    return;
  }
  list.className = '';
  for (const light of lights) {
    const item = document.createElement('div');
    item.className = 'light-item';
    buildLightUI(light, item);
    list.appendChild(item);
  }
}

// ---------------------------------------------------------------- body list

const CUSTOM_TYPES = { constant: 'Constant n', cauchy: 'Cauchy', sellmeier: 'Sellmeier' };
// Not refractive-index models — special optical roles a body can take instead. Blocker
// absorbs light by default (a face-level surface condition still overrides that — see
// brepTracer.js); No Impact always matches the surrounding IOR so it never refracts.
const SPECIAL_TYPES = { blocker: 'Blocker', noImpact: 'No Impact' };

function materialSelectValue(body) {
  if (body.isLightSource) return 'lightsource';
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.type !== body.material.type) continue;
    if (TYPE_FIELDS[preset.type].every((f) => preset[f] === body.material[f])) {
      return 'preset:' + name;
    }
  }
  for (const [name, mat] of Object.entries(materialLibrary)) {
    if (JSON.stringify(mat) === JSON.stringify(body.material)) return 'library:' + name;
  }
  return 'type:' + body.material.type;
}

// Turns a body into a light-emitting source: removes it from refractive-body physics
// (see brepTracer.js's body loop, which skips faceTable.bodies entries flagged
// isLightSource) and creates a matching body-based LightSource positioned at the
// body's true volumetric centroid (see occt.buildFaceTable/computeBodyCentroid).
function convertBodyToLightSource(body) {
  body.isLightSource = true;
  const light = createBodyLight(body.id, 'point');
  body.lightId = light.id;
  addLight(light, new THREE.Vector3(body.centroid.x, body.centroid.y, body.centroid.z));
}

function revertBodyToMaterial(body) {
  body.isLightSource = false;
  if (body.lightId != null) removeLight(body.lightId);
  body.lightId = null;
}

function buildMaterialUI(body, container) {
  container.innerHTML = '';

  const select = document.createElement('select');
  for (const [key, label] of Object.entries(CUSTOM_TYPES)) {
    select.add(new Option(label + ' (custom)', 'type:' + key));
  }
  for (const [key, label] of Object.entries(SPECIAL_TYPES)) {
    select.add(new Option(label, 'type:' + key));
  }
  for (const name of Object.keys(PRESETS)) {
    select.add(new Option(name, 'preset:' + name));
  }
  if (Object.keys(materialLibrary).length > 0) {
    const libSep = new Option('── My Materials ──', '');
    libSep.disabled = true;
    select.add(libSep);
    for (const name of Object.keys(materialLibrary)) {
      select.add(new Option(name, 'library:' + name));
    }
  }
  const separator = new Option('──────────', '');
  separator.disabled = true;
  select.add(separator);
  select.add(new Option('Light Source', 'lightsource'));
  select.value = materialSelectValue(body);
  select.addEventListener('change', () => {
    if (select.value === 'lightsource') {
      convertBodyToLightSource(body);
      buildMaterialUI(body, container);
      requestTrace();
      return;
    }
    if (body.isLightSource) revertBodyToMaterial(body);

    // split on the FIRST colon only — preset/library names can contain colons
    // themselves (e.g. "YAG:Ce³⁺-doped borosilicate glass"), so a plain split(':')
    // would truncate them
    const sep = select.value.indexOf(':');
    const kind = select.value.slice(0, sep);
    const value = select.value.slice(sep + 1);
    if (kind === 'preset') {
      body.material = { ...PRESETS[value] };
    } else if (kind === 'library') {
      body.material = JSON.parse(JSON.stringify(materialLibrary[value]));
    } else {
      // always reseed (even if `value` matches the current type) — the previous
      // material may have been a preset of this same type, and selecting "(custom)"
      // should drop its phosphor config, not silently inherit it. Seed with generic
      // starting coefficients that don't exactly equal any named preset — otherwise
      // the dropdown immediately relabels "(custom)" back to whichever preset the seed
      // happens to match (see materialSelectValue)
      if (value === 'constant') body.material = { type: 'constant', n: 1.5, phosphor: null };
      else if (value === 'cauchy') body.material = { type: 'cauchy', A: 1.5, B: 0.005, C: 0, phosphor: null };
      else if (value === 'blocker') body.material = { type: 'blocker', n: 1, phosphor: null };
      else if (value === 'noImpact') body.material = { type: 'noImpact', phosphor: null };
      else body.material = { type: 'sellmeier', B1: 1.0, B2: 0.2, B3: 0.9, C1: 0.01, C2: 0.02, C3: 100, phosphor: null };
    }
    buildMaterialUI(body, container);
    requestTrace();
  });
  container.appendChild(select);

  if (body.isLightSource) {
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = 'Configured as a light source — see the Light Sources section below.';
    container.appendChild(note);
    return;
  }

  const libRow = document.createElement('div');
  libRow.className = 'row';
  const libBtn = document.createElement('button');
  libBtn.textContent = '☆ Save to my materials';
  libBtn.addEventListener('click', () => {
    const name = prompt('Name for this material:');
    if (!name) return;
    saveMaterialLibraryEntry(name, body.material);
    rebuildBodyList(); // every body's dropdown picks up the new "My Materials" entry
  });
  libRow.appendChild(libBtn);
  container.appendChild(libRow);

  if (body.material.type === 'blocker' || body.material.type === 'noImpact') {
    const note = document.createElement('div');
    note.className = 'muted small';
    note.textContent = body.material.type === 'blocker'
      ? 'Absorbs all light by default. A fixed/dichroic reflectivity on one of its surfaces still reflects its share — the rest is absorbed, not transmitted.'
      : 'Always matches the surrounding index (Surrounding n, in Tracing) — rays pass through unrefracted. Surface conditions on its faces still apply.';
    container.appendChild(note);
  }

  const grid = document.createElement('div');
  grid.className = 'coef-grid';
  for (const field of TYPE_FIELDS[body.material.type] || []) {
    const label = document.createElement('label');
    label.textContent = field;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = body.material[field];
    input.addEventListener('change', () => {
      body.material[field] = Number(input.value) || 0;
      if (body.material.type === 'constant') {
        body.material.n = Math.max(1, body.material.n);
        input.value = body.material.n;
      }
      select.value = materialSelectValue(body); // drops back to "custom" if edited
      requestTrace();
    });
    label.appendChild(input);
    grid.appendChild(label);
  }
  container.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'n-hint';
  hint.dataset.bodyId = String(body.id);
  container.appendChild(hint);

  // Phosphor is independent of the IOR type above — any material (custom or preset)
  // can have bulk conversion enabled, matching how a real phosphor is just particles
  // suspended in a normal refractive binder. The two YAG:Ce³⁺ presets enable it
  // automatically with realistic starting values; still fully editable afterward.
  const phosphorToggle = document.createElement('label');
  phosphorToggle.className = 'check';
  const phosphorCheckbox = document.createElement('input');
  phosphorCheckbox.type = 'checkbox';
  phosphorCheckbox.checked = !!body.material.phosphor;
  phosphorToggle.append(phosphorCheckbox, document.createTextNode(' Enable phosphor conversion'));
  phosphorCheckbox.addEventListener('change', () => {
    body.material.phosphor = phosphorCheckbox.checked ? defaultVolumePhosphorConfig() : null;
    buildMaterialUI(body, container);
    requestTrace();
  });
  container.appendChild(phosphorToggle);

  if (body.material.phosphor) {
    const p = body.material.phosphor;
    const excLabel = document.createElement('div');
    excLabel.className = 'muted small'; excLabel.textContent = 'Excitation (absorbs)';
    container.appendChild(excLabel);
    container.appendChild(createBandListEditor(p.excitationBands, () => requestTrace(), { minOne: true }));

    const emLabel = document.createElement('div');
    emLabel.className = 'muted small'; emLabel.textContent = 'Emission (re-emits)';
    container.appendChild(emLabel);
    container.appendChild(createBandListEditor(p.emissionBands, () => requestTrace(), { minOne: true }));

    const effRow = document.createElement('div');
    effRow.className = 'slider-row';
    const effLabel = document.createElement('span'); effLabel.textContent = 'Efficiency';
    const effSlider = document.createElement('input');
    effSlider.type = 'range'; effSlider.min = 0; effSlider.max = 1; effSlider.step = 0.01;
    effSlider.value = p.efficiency;
    const effVal = document.createElement('span'); effVal.className = 'val';
    effVal.textContent = Number(effSlider.value).toFixed(2);
    effSlider.addEventListener('input', () => {
      p.efficiency = Number(effSlider.value);
      effVal.textContent = p.efficiency.toFixed(2);
      requestTrace();
    });
    effRow.append(effLabel, effSlider, effVal);
    container.appendChild(effRow);

    const depthRow = document.createElement('div');
    depthRow.className = 'slider-row';
    const depthLabel = document.createElement('span'); depthLabel.textContent = 'Conv. depth';
    const depthInput = document.createElement('input');
    depthInput.type = 'number'; depthInput.className = 'val-input'; depthInput.min = 0.01; depthInput.step = 0.1;
    depthInput.value = p.conversionDepth;
    depthInput.title = 'Mean path length (mm) before an excitable photon converts — thicker sections of the body convert more light, per Beer-Lambert absorption.';
    depthInput.addEventListener('change', () => {
      p.conversionDepth = Math.max(0.01, Number(depthInput.value) || p.conversionDepth);
      depthInput.value = p.conversionDepth;
      requestTrace();
    });
    depthRow.append(depthLabel, depthInput);
    container.appendChild(depthRow);
  }
}

function rebuildBodyList() {
  const list = $('body-list');
  list.innerHTML = '';
  if (!faceTable || faceTable.bodies.length === 0) {
    list.textContent = 'No model loaded yet.';
    list.className = 'muted small';
    return;
  }
  list.className = '';
  for (const body of faceTable.bodies) {
    const item = document.createElement('div');
    item.className = 'body-item';

    const nameRow = document.createElement('div');
    nameRow.className = 'body-row';
    const name = document.createElement('div');
    name.className = 'body-name';
    name.textContent = body.name || `Body ${body.id + 1}`;
    name.title = `${body.faceIds.length} B-rep surfaces`;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'remove';
    del.title = 'Remove this object from the scene entirely';
    del.addEventListener('click', () => removeSceneObject(body._entryId));
    nameRow.append(name, del);

    const row = document.createElement('div');
    row.className = 'body-row';
    const label = document.createElement('label');
    label.textContent = `Material (${body.faceIds.length} surfaces)`;
    row.append(label);

    const matBox = document.createElement('div');
    buildMaterialUI(body, matBox);

    item.append(nameRow, row, matBox);
    list.appendChild(item);
  }
  updateIorHints();
}

// ------------------------------------------------------------ model loading
//
// Unlike InventorRayOptics (one shape synced from the live Inventor document), any
// number of STEP files and/or demo shapes can be loaded here side by side, each
// independently removable. occt.js's whole pipeline (buildFaceTable, the tracer)
// always targets ONE shape, so every add/remove rebuilds a fresh merged compound from
// whatever `sceneModel` currently holds and reruns buildFaceTable on it — occt-assigned
// body/face ids are just positions in that fresh traversal, not stable identities.
// `bodyStateByEntryId`/`faceStateByKey` are the stable store (keyed by sceneModel's own
// entry id, which IS stable) that survives across rebuilds; body-light associations
// (`light.bodyId`) are remapped the same way since they also point at a rebuild-local id.

const bodyStateByEntryId = new Map(); // entryId -> { material, isLightSource, lightId }
const faceStateByKey = new Map();     // `${entryId}:${localFaceIndex}` -> { reflectivity, dichroic, phosphor, map }

async function ensureOcct(overlay) {
  if (!oc) {
    oc = await initOcct((msg) => { if (overlay) overlay.querySelector('.msg').textContent = msg; });
    sceneModel = makeSceneModel(oc);
  }
  return oc;
}

function pullLiveStateIntoStorage() {
  if (!faceTable) return;
  for (const body of faceTable.bodies) {
    const bstate = bodyStateByEntryId.get(body._entryId);
    if (bstate) { bstate.material = body.material; bstate.isLightSource = body.isLightSource; bstate.lightId = body.lightId; }
  }
  for (const face of faceTable.faces) {
    const fstate = faceStateByKey.get(face._stateKey);
    if (fstate) {
      fstate.reflectivity = face.reflectivity;
      fstate.dichroic = face.dichroic;
      fstate.phosphor = face.phosphor;
      fstate.map = face.map;
    }
  }
}

// Rebuilds faceTable + display meshes from whatever `sceneModel` currently holds,
// preserving every body/face customization (and body-light associations) across the
// rebuild via the stable entry-id-keyed stores above.
function rebuildFaceTableFromSceneModel() {
  clearSelection();
  clearRays();
  clearMaps();
  pullLiveStateIntoStorage();

  // body-light associations point at the OLD numeric body id — remap via entryId
  const oldBodyIdToEntryId = new Map((faceTable?.bodies || []).map((b) => [b.id, b._entryId]));

  for (const mesh of faceMeshes.values()) { mesh.geometry.dispose(); modelGroup.remove(mesh); }
  faceMeshes.clear();
  if (faceTable) disposeFaceTable(faceTable);
  faceTable = null;
  if (currentCompound) currentCompound.delete();
  currentCompound = null;

  const compound = sceneModel.buildCompound();
  currentCompound = compound; // kept alive until the NEXT rebuild — see the declaration above
  if (compound) {
    faceTable = buildFaceTable(oc, compound);

    const entries = sceneModel.entries;
    faceTable.bodies.forEach((body, i) => {
      const entry = entries[i];
      let bstate = bodyStateByEntryId.get(entry.id);
      if (!bstate) {
        bstate = { material: defaultMaterial(), isLightSource: false, lightId: null };
        bodyStateByEntryId.set(entry.id, bstate);
      }
      body.material = bstate.material;
      body.isLightSource = bstate.isLightSource;
      body.lightId = bstate.lightId;
      body.name = entry.name;
      body._entryId = entry.id;

      body.faceIds.forEach((faceId, localIdx) => {
        const face = faceTable.faces[faceId];
        const key = `${entry.id}:${localIdx}`;
        let fstate = faceStateByKey.get(key);
        if (!fstate) {
          fstate = { reflectivity: null, dichroic: null, phosphor: null, map: null };
          faceStateByKey.set(key, fstate);
        }
        face.reflectivity = fstate.reflectivity;
        face.dichroic = fstate.dichroic;
        face.phosphor = fstate.phosphor;
        face.map = fstate.map;
        face._stateKey = key;
      });
    });

    const newEntryIdToBodyId = new Map(faceTable.bodies.map((b) => [b._entryId, b.id]));
    for (const light of lights) {
      if (light.kind !== 'body') continue;
      const entryId = oldBodyIdToEntryId.get(light.bodyId);
      const newBodyId = entryId != null ? newEntryIdToBodyId.get(entryId) : undefined;
      if (newBodyId != null) light.bodyId = newBodyId;
      else removeLight(light.id); // that body no longer exists — its light can't either
    }

    const meshData = buildDisplayMeshes(oc, compound, faceTable, 0.1, 15);
    for (const f of faceTable.faces) {
      const data = meshData.get(f.id);
      if (!data) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeVertexNormals();
      const mesh = new THREE.Mesh(geometry, NORMAL_MATERIAL);
      mesh.userData.faceId = f.id;
      mesh.userData.bodyId = f.bodyId;
      faceMeshes.set(f.id, mesh);
      modelGroup.add(mesh);
    }
  } else {
    // every object removed — also drop any now-dangling body lights
    for (const light of [...lights]) if (light.kind === 'body') removeLight(light.id);
  }

  rebuildBodyList();
  fitView();
  $('model-status').textContent = faceTable
    ? `Loaded ${faceTable.bodies.length} body/bodies, ${faceTable.faces.length} surfaces.`
    : 'No model loaded yet.';
  requestTrace();
}

function removeSceneObject(entryId) {
  sceneModel.remove(entryId);
  bodyStateByEntryId.delete(entryId);
  for (const key of [...faceStateByKey.keys()]) {
    if (key.startsWith(`${entryId}:`)) faceStateByKey.delete(key);
  }
  rebuildFaceTableFromSceneModel();
}

function showOverlay(text) {
  let overlay = $('loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'loading-overlay';
    overlay.innerHTML = '<div class="msg"></div><div class="progress-track"><div class="progress-fill"></div></div>';
    viewport.appendChild(overlay);
  }
  overlay.querySelector('.msg').textContent = text;
  return overlay;
}
function hideOverlay() {
  $('loading-overlay')?.remove();
}

async function importStepFiles(files) {
  const overlay = showOverlay('Starting…');
  $('model-status').textContent = 'Loading model…';
  try {
    await ensureOcct(overlay);
    for (const file of files) {
      overlay.querySelector('.msg').textContent = `Reading ${file.name}…`;
      const url = URL.createObjectURL(file);
      try {
        const shape = await readStepFromUrl(oc, url);
        sceneModel.add(shape, file.name);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    rebuildFaceTableFromSceneModel();
  } catch (err) {
    console.error(err);
    overlay.innerHTML = `<div class="error">${describeException(oc, err)}</div>`;
    $('model-status').textContent = 'Failed to load model — see console.';
    return;
  }
  hideOverlay();
}

async function addDemoShape(makeShape, name) {
  const overlay = showOverlay('Starting…');
  try {
    await ensureOcct(overlay);
    const shape = makeShape(oc);
    sceneModel.add(shape, name);
    rebuildFaceTableFromSceneModel();
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  }
  hideOverlay();
}

// ------------------------------------------------------------ face selection

function clearSelection() {
  selectedFaceId = null;
  refreshEmitterHighlights(); // restores NORMAL_MATERIAL or EMITTER_MATERIAL as appropriate
  $('face-panel').hidden = false;
  $('face-controls').hidden = true;
}

// Selected-surface reflectivity mode: 'fresnel' (physical, wavelength-independent
// dielectric reflectance) | 'fixed' (flat scalar 0..1) | 'dichroic' (wavelength-
// selective, see spectralBands.js). Exactly one of face.reflectivity/face.dichroic
// reflects the active mode at any time; buildFacePanel below is the single place that
// interprets/sets them, mirroring buildMaterialUI's preset-dropdown pattern.
function faceReflectivityMode(face) {
  if (face.dichroic) return 'dichroic';
  if (face.phosphor) return 'phosphor';
  if (face.map) return 'map';
  return face.reflectivity === null ? 'fresnel' : 'fixed';
}

function buildFacePanel(face, container) {
  container.innerHTML = '';
  const idx = faceTable.faces.indexOf(face);
  const owningBody = faceTable.bodies.find((b) => b.id === face.bodyId);
  const info = document.createElement('div');
  info.className = 'info';
  info.textContent = `Surface ${idx + 1} of ${faceTable.faces.length} (${owningBody?.name || `body ${face.bodyId + 1}`})`;
  container.appendChild(info);

  const modeRow = document.createElement('div');
  modeRow.className = 'reflectivity-mode';
  const modeSelect = document.createElement('select');
  modeSelect.add(new Option('Auto (Fresnel equations)', 'fresnel'));
  modeSelect.add(new Option('Fixed reflectivity', 'fixed'));
  modeSelect.add(new Option('Dichroic mirror', 'dichroic'));
  modeSelect.add(new Option('Phosphor (reflective)', 'phosphor'));
  modeSelect.add(new Option('Map', 'map'));
  modeSelect.value = faceReflectivityMode(face);
  modeSelect.addEventListener('change', () => {
    face.reflectivity = null;
    face.dichroic = null;
    face.phosphor = null;
    face.map = null;
    if (modeSelect.value === 'fixed') {
      face.reflectivity = 0.5;
    } else if (modeSelect.value === 'dichroic') {
      face.dichroic = { bands: [defaultBand()] };
    } else if (modeSelect.value === 'phosphor') {
      face.phosphor = defaultPhosphorConfig();
    } else if (modeSelect.value === 'map') {
      face.map = { block: true, opacity: 1 };
    }
    buildFacePanel(face, container);
    requestTrace();
  });
  modeRow.appendChild(modeSelect);
  container.appendChild(modeRow);

  if (modeSelect.value === 'fixed') {
    const row = document.createElement('div');
    row.className = 'slider-row';
    const label = document.createElement('span');
    label.textContent = 'Reflectivity';
    const slider = document.createElement('input');
    slider.type = 'range'; slider.min = 0; slider.max = 1; slider.step = 0.01;
    slider.value = face.reflectivity;
    const val = document.createElement('span');
    val.className = 'val';
    val.textContent = Number(slider.value).toFixed(2);
    slider.addEventListener('input', () => {
      face.reflectivity = Number(slider.value);
      val.textContent = face.reflectivity.toFixed(2);
      requestTrace();
    });
    row.append(label, slider, val);
    container.appendChild(row);
  } else if (modeSelect.value === 'dichroic') {
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Reflects wavelengths within each band, transmits (refracts) the rest. Best seen in Spectrum light mode.';
    container.appendChild(hint);
    const editor = createBandListEditor(face.dichroic.bands, () => requestTrace());
    container.appendChild(editor);
  } else if (modeSelect.value === 'phosphor') {
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Absorbs light in the excitation bands and re-emits it diffusely at a resampled wavelength from the emission bands. Best seen in Spectrum light mode.';
    container.appendChild(hint);

    const excLabel = document.createElement('div');
    excLabel.className = 'muted small'; excLabel.textContent = 'Excitation (absorbs)';
    container.appendChild(excLabel);
    container.appendChild(createBandListEditor(face.phosphor.excitationBands, () => requestTrace(), { minOne: true }));

    const emLabel = document.createElement('div');
    emLabel.className = 'muted small'; emLabel.textContent = 'Emission (re-emits)';
    container.appendChild(emLabel);
    container.appendChild(createBandListEditor(face.phosphor.emissionBands, () => requestTrace(), { minOne: true }));

    const effRow = document.createElement('div');
    effRow.className = 'slider-row';
    const effLabel = document.createElement('span');
    effLabel.textContent = 'Efficiency';
    const effSlider = document.createElement('input');
    effSlider.type = 'range'; effSlider.min = 0; effSlider.max = 1; effSlider.step = 0.01;
    effSlider.value = face.phosphor.efficiency;
    const effVal = document.createElement('span');
    effVal.className = 'val';
    effVal.textContent = Number(effSlider.value).toFixed(2);
    effSlider.addEventListener('input', () => {
      face.phosphor.efficiency = Number(effSlider.value);
      effVal.textContent = face.phosphor.efficiency.toFixed(2);
      requestTrace();
    });
    effRow.append(effLabel, effSlider, effVal);
    container.appendChild(effRow);
  } else if (modeSelect.value === 'map') {
    const hint = document.createElement('div');
    hint.className = 'muted small';
    hint.textContent = 'Records where rays hit this surface as a splat heatmap (color/brightness from each ray\'s wavelength/energy). Rebuilt fresh every trace.';
    container.appendChild(hint);

    const blockToggle = document.createElement('label');
    blockToggle.className = 'check';
    const blockCheckbox = document.createElement('input');
    blockCheckbox.type = 'checkbox';
    blockCheckbox.checked = face.map.block;
    blockToggle.append(blockCheckbox, document.createTextNode(' Block (absorb the ray here)'));
    blockCheckbox.addEventListener('change', () => {
      face.map.block = blockCheckbox.checked;
      requestTrace();
    });
    container.appendChild(blockToggle);

    const opacityRow = document.createElement('div');
    opacityRow.className = 'slider-row';
    const opacityLabel = document.createElement('span');
    opacityLabel.textContent = 'Transparency';
    const opacitySlider = document.createElement('input');
    opacitySlider.type = 'range'; opacitySlider.min = 0; opacitySlider.max = 1; opacitySlider.step = 0.01;
    opacitySlider.value = face.map.opacity;
    const opacityVal = document.createElement('span');
    opacityVal.className = 'val';
    opacityVal.textContent = Number(opacitySlider.value).toFixed(2);
    opacitySlider.addEventListener('input', () => {
      face.map.opacity = Number(opacitySlider.value);
      opacityVal.textContent = face.map.opacity.toFixed(2);
      setMapGroupOpacity(face.id, face.map.opacity); // live — no retrace needed
    });
    opacityRow.append(opacityLabel, opacitySlider, opacityVal);
    container.appendChild(opacityRow);
  }

  const deselectBtn = document.createElement('button');
  deselectBtn.textContent = 'Deselect';
  deselectBtn.addEventListener('click', clearSelection);
  container.appendChild(deselectBtn);
}

function selectFace(faceId) {
  const face = faceTable.faces.find((f) => f.id === faceId);
  const mesh = faceMeshes.get(faceId);
  if (!face || !mesh) return;
  clearSelection();
  selectedFaceId = faceId;
  mesh.material = HIGHLIGHT_MATERIAL;

  buildFacePanel(face, $('face-controls'));
  $('face-panel').hidden = true;
  $('face-controls').hidden = false;
}

// click-vs-drag detection for picking
let downPos = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  downPos = { x: e.clientX, y: e.clientY };
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
  downPos = null;
  if (moved > 5) return;
  if (lightGizmo.dragging || lightGizmo.axis) return; // interacting with a light gizmo

  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects([...faceMeshes.values()], false);

  if (emitterSelectionLightId !== null) {
    const light = lights.find((l) => l.id === emitterSelectionLightId);
    if (light && hits.length > 0) {
      const faceId = hits[0].object.userData.faceId;
      if (light.selectedFaceIds.has(faceId)) light.selectedFaceIds.delete(faceId);
      else light.selectedFaceIds.add(faceId);
      refreshEmitterHighlights();
      rebuildLightList();
      requestTrace();
    }
    return;
  }

  if (hits.length > 0) {
    selectFace(hits[0].object.userData.faceId);
  } else {
    clearSelection();
  }
});

// ----------------------------------------------------------------- tracing

function clearRays() {
  if (rayLines) {
    scene.remove(rayLines);
    rayLines.geometry.dispose();
    rayLines.material.dispose();
    rayLines = null;
  }
}

// ------------------------------------------------------------- map splats

// One shared white-to-transparent radial gradient, reused (tinted per-splat via each
// mesh's own material.color) rather than building a texture per splat.
let splatTexture = null;
function getSplatTexture() {
  if (splatTexture) return splatTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  splatTexture = new THREE.CanvasTexture(canvas);
  return splatTexture;
}

const mapsGroup = new THREE.Group(); // holds one sub-group per Map-mode face
scene.add(mapsGroup);
const mapGroups = new Map(); // faceId -> THREE.Group of splat meshes

function clearMaps() {
  for (const group of mapGroups.values()) {
    for (const mesh of group.children) { mesh.geometry.dispose(); mesh.material.dispose(); }
    mapsGroup.remove(group);
  }
  mapGroups.clear();
}

// Every ray hit on a Map-mode face becomes a small flat circular "splat" decal aligned
// with the surface normal at that point (not a camera-facing billboard — a billboard
// would visibly detach from the surface at grazing view angles). Color from the ray's
// wavelength, base opacity from its energy (already gain/weight-scaled, same as
// buildRayLines' segments), additively blended so overlapping hits accumulate brightness
// like a real fluence heatmap. `face.map.opacity` (the Transparency slider) is applied
// as a further multiplier, stored so the slider can adjust it live without a retrace.
function rebuildMapSplats(hits) {
  clearMaps();
  if (hits.length === 0) return;
  const texture = getSplatTexture();
  const radius = Math.max(sceneDiag * 0.015, 0.05);

  for (const hit of hits) {
    const face = faceTable?.faces.find((f) => f.id === hit.faceId);
    const faceOpacity = face?.map?.opacity ?? 1;

    let group = mapGroups.get(hit.faceId);
    if (!group) {
      group = new THREE.Group();
      mapGroups.set(hit.faceId, group);
      mapsGroup.add(group);
    }

    const baseAlpha = Math.min(1, hit.energy);
    const rgb = wavelengthToRGB(hit.wavelength);
    const material = new THREE.MeshBasicMaterial({
      map: texture, color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, opacity: baseAlpha * faceOpacity,
    });
    const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius * (0.5 + 0.5 * baseAlpha), 16), material);
    mesh.position.copy(hit.point).addScaledVector(hit.normal, Math.max(sceneDiag * 0.0005, 1e-4));
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), hit.normal);
    mesh.userData.baseAlpha = baseAlpha;
    group.add(mesh);
  }
}

function setMapGroupOpacity(faceId, opacity) {
  const group = mapGroups.get(faceId);
  if (!group) return;
  for (const mesh of group.children) mesh.material.opacity = mesh.userData.baseAlpha * opacity;
}

// direction a "custom aim" cone should point: the light's own local -Z axis, in world
// space — this is what the rotate gizmo actually controls (see makeLightObject's arrow)
function customAimDirection(obj) {
  return new THREE.Vector3(0, 0, -1).applyQuaternion(obj.group.quaternion).normalize();
}

// Multi-origin emission for a body-based light in 'surfaces' or 'body' submode: each
// sampled point on the relevant faces is its own ray origin, with a direction either
// exactly along that point's exact analytic normal, or randomly within
// `surfaceMaxAngle` of it (see optics.randomConeDirection — an independent Monte Carlo
// draw per point, not a shared deterministic fan). Samples are spread evenly across
// the relevant faces (roughly `rayCount / faceCount` each); `sampleFacePoints` may
// return fewer than requested for a small trimmed region.
function generateBodyEmissionRays(light, rayCount) {
  const body = faceTable.bodies.find((b) => b.id === light.bodyId);
  if (!body) return [];
  const faceIds = light.subMode === 'body' ? body.faceIds : [...light.selectedFaceIds];
  if (faceIds.length === 0) return [];

  // ray DENSITY (not per-ray energy) carries a custom profile's shape — see trace()'s
  // point-like path for the same change. Built once, reused for every sampled point.
  const sampler = light.angularProfile ? buildAngleSampler(light.angularProfile, ANGULAR_PROFILE_MAX_DEG) : null;

  const perFace = Math.max(1, Math.ceil(rayCount / faceIds.length));
  const rays = [];
  for (const faceId of faceIds) {
    const face = faceTable.faces[faceId];
    if (!face) continue;
    for (const s of sampleFacePoints(oc, face, perFace)) {
      const normal = new THREE.Vector3(s.normal.x, s.normal.y, s.normal.z).normalize();
      let dir;
      if (light.surfaceEmission === 'profile' || (light.surfaceEmission === 'maxAngle' && sampler)) {
        dir = profileWeightedDirection(normal, sampler);
      } else if (light.surfaceEmission === 'maxAngle') {
        dir = randomConeDirection(normal, light.surfaceMaxAngle);
      } else {
        dir = normal;
      }
      rays.push({ origin: new THREE.Vector3(s.point.x, s.point.y, s.point.z), dir, energy: 1 });
    }
  }
  return rays;
}

function trace() {
  if (!oc || !faceTable) return;
  clearRays();
  const tp = tracingParams();
  updateSceneScale();

  const allSegments = [];
  const allMapHits = [];
  let totalSegments = 0;
  let totalMs = 0;
  let maxDepth = 0;
  let capped = false;
  const REFERENCE_RAYS = 500; // puts a 500-ray, power-1 trace at comfortable brightness

  for (const light of lights) {
    const obj = lightObjects.get(light.id);
    if (!obj) continue;

    const rayCount = rayCountFromSlider(light.raySlider);
    const wavelengths = traceWavelengths(light);
    // intensity is this light's total power output: split evenly across all its
    // emitted rays and spectral samples, so raising ray count dims (not thins) rays
    const gain = (light.intensity * REFERENCE_RAYS) / (rayCount * wavelengths.length);

    // Two emission shapes: a single-origin fan (point lights, and body lights in
    // 'point'/centroid submode) using the existing deterministic direction fan; or a
    // multi-origin set (body lights in 'surfaces'/'body' submode) where each sampled
    // point on the body's own surface is its own ray origin with its own normal.
    let rays = null, origin = null, directions = null;
    if (light.kind === 'body' && light.subMode !== 'point') {
      rays = generateBodyEmissionRays(light, rayCount);
    } else {
      origin = obj.group.position.clone();
      let axis;
      if (light.emissionMode === 'custom') axis = customAimDirection(obj);
      else axis = modelCenter().sub(origin);
      if (axis.lengthSq() < 1e-9) axis.set(-1, 0, 0);

      if (light.angularProfile) {
        // ray DENSITY (not per-ray energy) now carries the profile's shape — every
        // ray gets the same fixed energy, importance-sampled toward bright angles
        // instead of a uniform-density fan weighted after the fact.
        const sampler = buildAngleSampler(light.angularProfile, ANGULAR_PROFILE_MAX_DEG);
        rays = [];
        for (let i = 0; i < rayCount; i++) {
          rays.push({ origin, dir: profileWeightedDirection(axis, sampler), energy: 1 });
        }
      } else {
        // the same ray fan is traced once per wavelength, so dispersion shows up as
        // spectral rays sharing a path until refraction separates them
        directions = emissionDirections(rayCount, light.emissionMode, axis, light.coneAngle);
      }
    }

    for (const { wavelength: wl, weight } of wavelengths) {
      // wavelength-aware per call, not precomputed for the pass's nominal `wl` — a
      // phosphor-converted ray carries a different wavelength than the pass it started
      // in, and its subsequent IOR lookups must reflect that
      const getIor = (bodyId, atWavelength) => {
        const body = faceTable.bodies.find((b) => b.id === bodyId);
        return body ? iorAt(body.material, atWavelength, tp.ambientIor) : 1.5;
      };
      const getPhosphor = (bodyId) => faceTable.bodies.find((b) => b.id === bodyId)?.material?.phosphor;
      const isBlocker = (bodyId) => faceTable.bodies.find((b) => b.id === bodyId)?.material?.type === 'blocker';
      const result = traceRaysBrep(oc, faceTable, getIor, getPhosphor, isBlocker, {
        ...(rays ? { rays } : { origin, directions }),
        wavelength: wl,
        ambientIor: tp.ambientIor,
        maxBounces: tp.maxBounces,
        minIntensity: tp.minIntensity,
        maxDist: sceneDiag * 1.5,
        eps: Math.max(sceneDiag * 1e-5, 1e-5),
      });
      // pre-scale by this light's own gain (and this sample's spectral weight — the
      // same "dim, don't drop" treatment as an angular profile) so segments from
      // different lights/ray counts/intensities combine correctly in one buildRayLines
      // call. Each segment already carries its own rgb, so a phosphor-converted ray's
      // tail renders in its new color even though it started this pass at wavelength `wl`.
      for (const s of result.segments) s.energy *= gain * weight;
      allSegments.push(...result.segments);
      for (const h of result.mapHits) h.energy *= gain * weight;
      allMapHits.push(...result.mapHits);
      totalSegments += result.stats.segments;
      totalMs += result.stats.timeMs;
      maxDepth = Math.max(maxDepth, result.stats.maxDepthReached);
      capped = capped || result.stats.capped;
    }

    const rgb = wavelengthToRGB(centerWavelength(light));
    obj.glow.color.setRGB(rgb[0], rgb[1], rgb[2]);
    obj.glow.intensity = light.intensity * sceneDiag * 0.5;
    obj.marker.material.color.setRGB(0.5 + rgb[0] * 0.5, 0.5 + rgb[1] * 0.5, 0.5 + rgb[2] * 0.5);
  }

  rayLines = buildRayLines(allSegments, 1); // gain already applied per-light above
  rayLines.visible = $('show-rays').checked;
  scene.add(rayLines);
  rebuildMapSplats(allMapHits);
  mapsGroup.visible = $('show-maps').checked;

  const lightCount = lights.length;
  $('trace-stats').textContent =
    `${lightCount} light${lightCount === 1 ? '' : 's'} → ` +
    `${totalSegments.toLocaleString()} segments, depth ≤ ${maxDepth}, ${totalMs.toFixed(0)} ms` +
    (capped ? ' (segment cap hit — lower ray count or bounces)' : '');
}

let traceTimer = null;
function requestTrace() {
  refreshValueLabels();
  if (!tracingEnabled || !$('auto-trace').checked) return;
  clearTimeout(traceTimer);
  traceTimer = setTimeout(trace, 120);
}

// Master gate: while off, no rays are ever computed (not via auto-trace, not via the
// manual "Trace Rays" button) so the user can freely configure lights/materials/faces
// first without paying for retraces on every edit. Starts off — see index.html.
let tracingEnabled = false;
function setTracingEnabled(on) {
  tracingEnabled = on;
  const btn = $('btn-toggle-tracing');
  btn.textContent = on ? 'Ray Tracing: ON — click to pause' : 'Ray Tracing: OFF — click to start';
  btn.classList.toggle('on', on);
  btn.classList.toggle('off', !on);
  $('btn-trace').disabled = !on;
  $('auto-trace').disabled = !on;
  if (on) {
    trace();
  } else {
    clearRays();
    clearMaps();
    $('trace-stats').textContent = '';
  }
}
$('btn-toggle-tracing').addEventListener('click', () => setTracingEnabled(!tracingEnabled));

// -------------------------------------------------------------- UI wiring

$('btn-import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length === 0) return;
  await importStepFiles(files);
});
$('btn-demo-prism').addEventListener('click', () => addDemoShape(makeDemoPrismShape, 'Demo Prism'));
$('btn-demo-sphere').addEventListener('click', () => addDemoShape(makeDemoSphereShape, 'Demo Ball Lens'));

$('btn-add-point-light').addEventListener('click', () => {
  const center = modelCenter();
  const light = createPointLight();
  addLight(light, new THREE.Vector3(center.x + 50, center.y + 10, center.z));
});

$('show-widgets').addEventListener('change', updateWidgetVisibility);

for (const id of ['max-bounces', 'min-intensity']) {
  $(id).addEventListener('input', requestTrace);
}
$('ambient-ior').addEventListener('change', requestTrace);
$('btn-trace').addEventListener('click', () => { refreshValueLabels(); trace(); });
$('btn-clear-rays').addEventListener('click', clearRays);
$('btn-fit').addEventListener('click', fitView);
$('show-grid').addEventListener('change', () => {
  grid.visible = axes.visible = $('show-grid').checked;
});
$('show-models').addEventListener('change', () => {
  modelGroup.visible = $('show-models').checked;
});
$('show-rays').addEventListener('change', () => {
  if (rayLines) rayLines.visible = $('show-rays').checked; // visibility only — no retrace
});
$('show-maps').addEventListener('change', () => {
  mapsGroup.visible = $('show-maps').checked; // visibility only — splats aren't rebuilt
});

window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

// ------------------------------------------------------- settings save/load
//
// No host application to attach named snapshots to (unlike InventorRayOptics' C#-backed
// per-document files) — Save downloads a JSON file, Load opens a file picker. Bodies/
// faces are matched by their occt-assigned id, which (unlike a live Inventor document)
// isn't stable here across a session that's added/removed objects since saving — good
// enough for "save before you close the tab, reload the same objects, load it back".

function serializeSettings() {
  return {
    bodies: faceTable ? faceTable.bodies.map((b) => ({
      id: b.id, material: b.material, isLightSource: b.isLightSource,
    })) : [],
    faces: faceTable ? faceTable.faces
      .filter((f) => f.reflectivity !== null || f.dichroic || f.phosphor || f.map)
      .map((f) => ({ id: f.id, reflectivity: f.reflectivity, dichroic: f.dichroic, phosphor: f.phosphor, map: f.map }))
      : [],
    lights: lights.filter((l) => !l.isDefault).map((light) => {
      const obj = lightObjects.get(light.id);
      const { id, selectedFaceIds, ...rest } = light;
      return {
        ...rest,
        selectedFaceIds: light.kind === 'body' ? [...light.selectedFaceIds] : undefined,
        transform: obj ? {
          position: { x: obj.group.position.x, y: obj.group.position.y, z: obj.group.position.z },
          quaternion: {
            x: obj.group.quaternion.x, y: obj.group.quaternion.y,
            z: obj.group.quaternion.z, w: obj.group.quaternion.w,
          },
        } : null,
      };
    }),
    tracing: {
      maxBounces: Number($('max-bounces').value),
      minIntensity: Number($('min-intensity').value),
      ambientIor: Number($('ambient-ior').value),
    },
  };
}

function applySettings(data) {
  if (!faceTable || !data) return;

  for (const saved of data.bodies || []) {
    const body = faceTable.bodies.find((b) => b.id === saved.id);
    if (!body) continue;
    if (body.isLightSource && !saved.isLightSource) revertBodyToMaterial(body);
    body.material = JSON.parse(JSON.stringify(saved.material));
  }

  for (const face of faceTable.faces) {
    face.reflectivity = null;
    face.dichroic = null;
    face.phosphor = null;
    face.map = null;
  }
  for (const saved of data.faces || []) {
    const face = faceTable.faces.find((f) => f.id === saved.id);
    if (!face) continue;
    face.reflectivity = saved.reflectivity;
    face.dichroic = saved.dichroic ? JSON.parse(JSON.stringify(saved.dichroic)) : null;
    face.phosphor = saved.phosphor ? JSON.parse(JSON.stringify(saved.phosphor)) : null;
    face.map = saved.map ? JSON.parse(JSON.stringify(saved.map)) : null;
  }

  for (const light of [...lights]) removeLight(light.id);
  emitterSelectionLightId = null;
  for (const saved of data.lights || []) {
    // fresh id from createPointLight/createBodyLight, not the saved one — the saved id
    // is a different session's bookkeeping and could collide with this session's
    const light = saved.kind === 'point' ? createPointLight() : createBodyLight(saved.bodyId, saved.subMode || 'point');
    const { id, selectedFaceIds, transform, ...savedFields } = saved;
    Object.assign(light, savedFields);
    if (light.kind === 'body') light.selectedFaceIds = new Set(selectedFaceIds || []);
    lights.push(light);
    const obj = makeLightObject(light);
    if (transform) {
      obj.group.position.set(transform.position.x, transform.position.y, transform.position.z);
      obj.group.quaternion.set(
        transform.quaternion.x, transform.quaternion.y, transform.quaternion.z, transform.quaternion.w
      );
    }
    lightObjects.set(light.id, obj);
    scene.add(obj.group);
    if (light.kind === 'body') {
      const body = faceTable.bodies.find((b) => b.id === light.bodyId);
      if (body) { body.isLightSource = true; body.lightId = light.id; }
    }
  }
  lights = reconcileDefaultLights(lights);
  ensureLightObjects();

  if (data.tracing) {
    $('max-bounces').value = data.tracing.maxBounces;
    $('min-intensity').value = data.tracing.minIntensity;
    $('ambient-ior').value = data.tracing.ambientIor;
  }

  rebuildBodyList();
  rebuildLightList();
  clearSelection();
  refreshEmitterHighlights();
  updateSceneScale();
  requestTrace();
}

$('btn-save-settings').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(serializeSettings(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'steprayoptics-settings.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
$('btn-load-settings').addEventListener('click', () => $('settings-file-input').click());
$('settings-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    applySettings(JSON.parse(await file.text()));
  } catch (err) {
    alert('Could not load that settings file: ' + (err.message || err));
  }
});

// ------------------------------------------------------------------- start

loadMaterialLibrary();
lights = reconcileDefaultLights(lights); // seeds the initial default point light
ensureLightObjects();
rebuildLightList();
refreshValueLabels();
setTracingEnabled(false); // starts disabled — see btn-toggle-tracing in index.html

// console/testing hook
window.__sro = {
  scene, camera, get oc() { return oc; }, get faceTable() { return faceTable; },
  get lights() { return lights; }, lightObjects,
  selectFace, trace, addLight, removeLight,
  importStepFiles, addDemoShape, removeSceneObject,
  serializeSettings, applySettings, setTracingEnabled,
  get materialLibrary() { return materialLibrary; },
};

(function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
})();
