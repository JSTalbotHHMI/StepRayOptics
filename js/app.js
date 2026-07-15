import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { loadStepFile, makeDemoPrism, makeDemoSphere } from './loader.js';
import { traceRays, buildRayLines, emissionDirections, wavelengthToRGB } from './tracer.js';
import { iorAt, PRESETS, TYPE_FIELDS } from './materials.js';

// Accelerated raycasting for all meshes with a bounds tree
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

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

// ------------------------------------------------------------- light source

const lightGroup = new THREE.Group();
const lightMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffcc })
);
const glow = new THREE.PointLight(0xffffff, 0, 400);
lightGroup.add(lightMarker, glow);
lightGroup.position.set(50, 10, 0);
scene.add(lightGroup);

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.attach(lightGroup);
gizmo.setSize(0.8);
scene.add(gizmo);
gizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
gizmo.addEventListener('objectChange', () => {
  syncLightInputs();
  requestTrace();
});

// aim target for the custom-direction cone: the cone always points from the
// light toward this marker (like a spotlight target)
const aimTarget = new THREE.Mesh(
  new THREE.OctahedronGeometry(1),
  new THREE.MeshBasicMaterial({ color: 0xff8844, wireframe: true })
);
aimTarget.position.set(0, 0, 0);
scene.add(aimTarget);

const aimGizmo = new TransformControls(camera, renderer.domElement);
aimGizmo.attach(aimTarget);
aimGizmo.setSize(0.6);
scene.add(aimGizmo);
aimGizmo.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
aimGizmo.addEventListener('objectChange', () => {
  syncAimInputs();
  requestTrace();
});

function updateAimVisibility() {
  const custom = $('emission-mode').value === 'custom';
  const showGizmo = custom && $('aim-gizmo').checked;
  aimTarget.visible = custom;
  aimGizmo.visible = showGizmo;
  aimGizmo.enabled = showGizmo;
}

// ------------------------------------------------------------------- state

const objects = [];        // SceneObjects from loader.js
let rayLines = null;       // current LineSegments of traced rays
let selected = null;       // { obj, face, faceIndex }
let highlightMesh = null;
let sceneDiag = 100;       // bounding diagonal, drives ray length / epsilon

// --------------------------------------------------------------- UI helpers

function rayCountFromSlider(s) {
  return Math.round(10 * Math.pow(2000, s / 100)); // 10 .. 20,000 (log scale)
}

function currentParams() {
  return {
    lightMode: $('light-mode').value,
    wavelength: Number($('wavelength').value),
    specMin: Number($('spec-min').value),
    specMax: Number($('spec-max').value),
    specSamples: Number($('spec-samples').value),
    intensity: Math.max(0, Number($('intensity-num').value) || 0),
    rayCount: rayCountFromSlider(Number($('ray-count').value)),
    emissionMode: $('emission-mode').value,
    coneAngle: Number($('cone-angle').value),
    maxBounces: Number($('max-bounces').value),
    minIntensity: Number($('min-intensity').value),
  };
}

// Wavelengths to trace, one entry per spectral sample.
function traceWavelengths(p) {
  if (p.lightMode !== 'spectrum') return [p.wavelength];
  const lo = Math.min(p.specMin, p.specMax);
  const hi = Math.max(p.specMin, p.specMax);
  const list = [];
  for (let i = 0; i < p.specSamples; i++) {
    list.push(lo + (hi - lo) * (p.specSamples === 1 ? 0.5 : i / (p.specSamples - 1)));
  }
  return list;
}

// Representative wavelength for UI hints (n(λ) readouts, glow color)
function centerWavelength(p) {
  return p.lightMode === 'spectrum' ? (p.specMin + p.specMax) / 2 : p.wavelength;
}

function cssColor(rgb) {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

function refreshValueLabels() {
  const p = currentParams();
  $('wavelength-val').textContent = p.wavelength;
  $('ray-count-val').textContent = p.rayCount;
  $('cone-angle-val').textContent = p.coneAngle;
  $('max-bounces-val').textContent = p.maxBounces;
  $('min-intensity-val').textContent = p.minIntensity.toFixed(3);
  $('spec-samples-val').textContent = p.specSamples;
  $('wl-swatch').style.background = cssColor(wavelengthToRGB(p.wavelength));
  $('cone-row').style.display = p.emissionMode !== 'sphere' ? 'flex' : 'none';
  $('aim-rows').hidden = p.emissionMode !== 'custom';
  updateAimVisibility();
  $('single-wl-rows').hidden = p.lightMode !== 'single';
  $('spectrum-rows').hidden = p.lightMode !== 'spectrum';
  if (p.lightMode === 'spectrum') {
    const stops = [];
    for (let i = 0; i <= 10; i++) {
      const wl = p.specMin + (p.specMax - p.specMin) * (i / 10);
      stops.push(`${cssColor(wavelengthToRGB(wl))} ${i * 10}%`);
    }
    $('spec-swatch').style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  }
  updateIorHints();
}

function updateIorHints() {
  const wl = centerWavelength(currentParams());
  for (const el of document.querySelectorAll('#object-list .n-hint')) {
    const obj = objects.find((o) => String(o.id) === el.dataset.objId);
    if (obj) el.textContent = `n(${Math.round(wl)} nm) = ${iorAt(obj.material, wl).toFixed(4)}`;
  }
}

function syncLightInputs() {
  $('light-x').value = lightGroup.position.x.toFixed(1);
  $('light-y').value = lightGroup.position.y.toFixed(1);
  $('light-z').value = lightGroup.position.z.toFixed(1);
}

function syncAimInputs() {
  $('aim-x').value = aimTarget.position.x.toFixed(1);
  $('aim-y').value = aimTarget.position.y.toFixed(1);
  $('aim-z').value = aimTarget.position.z.toFixed(1);
}

function modelsCenter() {
  if (objects.length === 0) return new THREE.Vector3(0, 0, 0);
  const box = new THREE.Box3();
  for (const o of objects) box.expandByObject(o.mesh);
  return box.getCenter(new THREE.Vector3());
}

function updateSceneScale() {
  const box = new THREE.Box3();
  for (const o of objects) box.expandByObject(o.mesh);
  box.expandByPoint(lightGroup.position);
  if (box.isEmpty()) {
    sceneDiag = 100;
  } else {
    sceneDiag = Math.max(box.getSize(new THREE.Vector3()).length(), 10);
  }
  lightMarker.scale.setScalar(Math.max(sceneDiag * 0.008, 0.3));
  aimTarget.scale.setScalar(Math.max(sceneDiag * 0.012, 0.4));
}

function fitView() {
  updateSceneScale();
  const center = objects.length > 0 ? modelsCenter() : lightGroup.position.clone();
  const dist = sceneDiag * 1.2;
  orbit.target.copy(center);
  const dir = camera.position.clone().sub(orbit.target).normalize();
  if (!isFinite(dir.length()) || dir.length() === 0) dir.set(1, 0.6, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
}

// -------------------------------------------------------------- object list

const CUSTOM_TYPES = { constant: 'Constant n', cauchy: 'Cauchy', sellmeier: 'Sellmeier' };

function materialSelectValue(obj) {
  for (const [name, preset] of Object.entries(PRESETS)) {
    if (preset.type !== obj.material.type) continue;
    if (TYPE_FIELDS[preset.type].every((f) => preset[f] === obj.material[f])) {
      return 'preset:' + name;
    }
  }
  return 'type:' + obj.material.type;
}

function buildMaterialUI(obj, container) {
  container.innerHTML = '';

  const select = document.createElement('select');
  for (const [key, label] of Object.entries(CUSTOM_TYPES)) {
    select.add(new Option(label + ' (custom)', 'type:' + key));
  }
  for (const name of Object.keys(PRESETS)) {
    select.add(new Option(name, 'preset:' + name));
  }
  select.value = materialSelectValue(obj);
  select.addEventListener('change', () => {
    const [kind, value] = select.value.split(':');
    if (kind === 'preset') {
      obj.material = { ...PRESETS[value] };
    } else if (value !== obj.material.type) {
      // sensible starting coefficients when switching model type
      if (value === 'constant') obj.material = { type: 'constant', n: 1.5 };
      else if (value === 'cauchy') obj.material = { type: 'cauchy', A: 1.5, B: 0.005, C: 0 };
      else obj.material = { ...PRESETS['N-BK7'] };
    }
    buildMaterialUI(obj, container);
    requestTrace();
  });
  container.appendChild(select);

  const grid = document.createElement('div');
  grid.className = 'coef-grid';
  for (const field of TYPE_FIELDS[obj.material.type]) {
    const label = document.createElement('label');
    label.textContent = field;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = 'any';
    input.value = obj.material[field];
    input.addEventListener('change', () => {
      obj.material[field] = Number(input.value) || 0;
      if (obj.material.type === 'constant') {
        obj.material.n = Math.max(1, obj.material.n);
        input.value = obj.material.n;
      }
      select.value = materialSelectValue(obj); // drops back to "custom" if edited
      requestTrace();
    });
    label.appendChild(input);
    grid.appendChild(label);
  }
  container.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'n-hint';
  hint.dataset.objId = String(obj.id);
  container.appendChild(hint);
}

function rebuildObjectList() {
  const list = $('object-list');
  list.innerHTML = '';
  for (const obj of objects) {
    const item = document.createElement('div');
    item.className = 'obj-item';

    const name = document.createElement('div');
    name.className = 'obj-name';
    name.textContent = obj.name;
    name.title = `${obj.name} — ${obj.faces.length} surfaces`;

    const row = document.createElement('div');
    row.className = 'obj-row';
    const label = document.createElement('label');
    label.textContent = 'Material';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'remove';
    del.addEventListener('click', () => removeObject(obj));
    row.append(label, del);

    const matBox = document.createElement('div');
    buildMaterialUI(obj, matBox);

    item.append(name, row, matBox);
    list.appendChild(item);
  }
  updateIorHints();
}

function addObject(obj) {
  objects.push(obj);
  scene.add(obj.mesh);
  rebuildObjectList();
  updateSceneScale();
  requestTrace();
}

function removeObject(obj) {
  const i = objects.indexOf(obj);
  if (i >= 0) objects.splice(i, 1);
  scene.remove(obj.mesh);
  obj.mesh.geometry.disposeBoundsTree();
  obj.mesh.geometry.dispose();
  if (selected && selected.obj === obj) clearSelection();
  rebuildObjectList();
  updateSceneScale();
  requestTrace();
}

// ------------------------------------------------------------ face selection

function clearSelection() {
  selected = null;
  if (highlightMesh) {
    scene.remove(highlightMesh);
    highlightMesh = null;
  }
  $('face-panel').hidden = false;
  $('face-controls').hidden = true;
}

function selectFace(obj, faceIndex) {
  const face = obj.faces.find((f) => faceIndex >= f.first && faceIndex <= f.last);
  if (!face) return;
  clearSelection();
  selected = { obj, face };

  // highlight shares the model's vertex buffers, drawing only this face's range
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', obj.mesh.geometry.getAttribute('position'));
  g.setIndex(obj.mesh.geometry.getIndex());
  g.setDrawRange(face.first * 3, (face.last - face.first + 1) * 3);
  highlightMesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    color: 0xffaa33,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  }));
  highlightMesh.applyMatrix4(obj.mesh.matrixWorld);
  scene.add(highlightMesh);

  const idx = obj.faces.indexOf(face);
  $('face-info').textContent =
    `${obj.name} — surface ${idx + 1} of ${obj.faces.length} ` +
    `(${face.last - face.first + 1} triangles)`;
  $('face-fresnel').checked = face.reflectivity === null;
  $('face-refl').value = face.reflectivity === null ? 0.5 : face.reflectivity;
  $('face-refl-val').textContent = Number($('face-refl').value).toFixed(2);
  $('face-refl-row').style.opacity = face.reflectivity === null ? 0.4 : 1;
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
  if (gizmo.dragging || gizmo.axis) return;       // interacting with the light gizmo
  if (aimGizmo.dragging || aimGizmo.axis) return; // interacting with the aim gizmo

  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(objects.map((o) => o.mesh), false);
  if (hits.length > 0) {
    selectFace(hits[0].object.userData.sceneObject, hits[0].faceIndex);
  } else {
    clearSelection();
  }
});

$('face-fresnel').addEventListener('change', () => {
  if (!selected) return;
  if ($('face-fresnel').checked) {
    selected.face.reflectivity = null;
    $('face-refl-row').style.opacity = 0.4;
  } else {
    selected.face.reflectivity = Number($('face-refl').value);
    $('face-refl-row').style.opacity = 1;
  }
  requestTrace();
});
$('face-refl').addEventListener('input', () => {
  $('face-refl-val').textContent = Number($('face-refl').value).toFixed(2);
  if (!selected || $('face-fresnel').checked) return;
  selected.face.reflectivity = Number($('face-refl').value);
  requestTrace();
});
$('btn-deselect').addEventListener('click', clearSelection);

// ----------------------------------------------------------------- tracing

function clearRays() {
  if (rayLines) {
    scene.remove(rayLines);
    rayLines.geometry.dispose();
    rayLines.material.dispose();
    rayLines = null;
  }
}

function trace() {
  clearRays();
  const p = currentParams();
  updateSceneScale();

  const origin = lightGroup.position.clone();
  let axis = p.emissionMode === 'custom'
    ? aimTarget.position.clone().sub(origin)
    : modelsCenter().sub(origin);
  if (axis.lengthSq() < 1e-9) axis.set(-1, 0, 0);
  // the same ray fan is traced once per wavelength, so dispersion shows up
  // as spectral rays sharing a path until refraction separates them
  const directions = emissionDirections(p.rayCount, p.emissionMode, axis, p.coneAngle);
  const wavelengths = traceWavelengths(p);

  const batches = [];
  let totalSegments = 0;
  let totalMs = 0;
  let maxDepth = 0;
  let capped = false;
  for (const wl of wavelengths) {
    const iors = new Map(objects.map((o) => [o, iorAt(o.material, wl)]));
    const result = traceRays(objects, {
      origin,
      directions,
      iors,
      maxBounces: p.maxBounces,
      minIntensity: p.minIntensity,
      maxDist: sceneDiag * 1.5,
      eps: Math.max(sceneDiag * 1e-5, 1e-5),
    });
    batches.push({ segments: result.segments, rgb: wavelengthToRGB(wl) });
    totalSegments += result.stats.segments;
    totalMs += result.stats.timeMs;
    maxDepth = Math.max(maxDepth, result.stats.maxDepthReached);
    capped = capped || result.stats.capped;
  }

  // intensity is the source's total power output: it is split evenly across
  // all emitted rays and spectral samples, so raising the ray count makes each
  // ray dimmer and the total light in the scene stays constant. The reference
  // constant puts a 500-ray, power-1 trace at comfortable screen brightness.
  const REFERENCE_RAYS = 500;
  const gain = (p.intensity * REFERENCE_RAYS) / (p.rayCount * wavelengths.length);
  rayLines = buildRayLines(batches, gain);
  scene.add(rayLines);

  const rgb = wavelengthToRGB(centerWavelength(p));
  glow.color.setRGB(rgb[0], rgb[1], rgb[2]);
  glow.intensity = p.intensity * sceneDiag * 0.5;
  lightMarker.material.color.setRGB(
    0.5 + rgb[0] * 0.5, 0.5 + rgb[1] * 0.5, 0.5 + rgb[2] * 0.5
  );

  $('trace-stats').textContent =
    `${p.rayCount}${wavelengths.length > 1 ? ` × ${wavelengths.length} λ` : ''} rays → ` +
    `${totalSegments.toLocaleString()} segments, depth ≤ ${maxDepth}, ${totalMs.toFixed(0)} ms` +
    (capped ? ' (segment cap hit — lower ray count or bounces)' : '');
}

let traceTimer = null;
function requestTrace() {
  refreshValueLabels();
  if (!$('auto-trace').checked) return;
  clearTimeout(traceTimer);
  traceTimer = setTimeout(trace, 120);
}

// -------------------------------------------------------------- UI wiring

$('btn-import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length === 0) return;
  const overlay = document.createElement('div');
  overlay.id = 'loading-overlay';
  overlay.textContent = 'Importing STEP…';
  viewport.appendChild(overlay);
  try {
    for (const f of files) {
      overlay.textContent = `Importing ${f.name}…`;
      const obj = await loadStepFile(f);
      addObject(obj);
    }
    fitView();
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
  } finally {
    overlay.remove();
  }
});

$('btn-demo-prism').addEventListener('click', () => { addObject(makeDemoPrism()); fitView(); });
$('btn-demo-sphere').addEventListener('click', () => { addObject(makeDemoSphere()); fitView(); });

for (const id of ['light-x', 'light-y', 'light-z']) {
  $(id).addEventListener('change', () => {
    lightGroup.position.set(
      Number($('light-x').value), Number($('light-y').value), Number($('light-z').value)
    );
    requestTrace();
  });
}
$('light-gizmo').addEventListener('change', () => {
  gizmo.visible = $('light-gizmo').checked;
  gizmo.enabled = $('light-gizmo').checked;
});

for (const id of ['aim-x', 'aim-y', 'aim-z']) {
  $(id).addEventListener('change', () => {
    aimTarget.position.set(
      Number($('aim-x').value), Number($('aim-y').value), Number($('aim-z').value)
    );
    requestTrace();
  });
}
$('aim-gizmo').addEventListener('change', updateAimVisibility);

for (const id of ['wavelength', 'ray-count', 'cone-angle', 'max-bounces', 'min-intensity', 'spec-samples']) {
  $(id).addEventListener('input', requestTrace);
}
// intensity: slider and text box stay in sync; the box accepts values beyond
// the slider's range
$('intensity').addEventListener('input', () => {
  $('intensity-num').value = Number($('intensity').value).toFixed(2);
  requestTrace();
});
$('intensity-num').addEventListener('change', () => {
  const v = Math.max(0, Number($('intensity-num').value) || 0);
  $('intensity-num').value = v;
  $('intensity').value = v; // clamps itself to the slider range
  requestTrace();
});
for (const id of ['emission-mode', 'light-mode', 'spec-min', 'spec-max']) {
  $(id).addEventListener('change', requestTrace);
}
$('btn-trace').addEventListener('click', () => { refreshValueLabels(); trace(); });
$('btn-clear-rays').addEventListener('click', clearRays);
$('btn-fit').addEventListener('click', fitView);
$('show-grid').addEventListener('change', () => {
  grid.visible = axes.visible = $('show-grid').checked;
});
$('show-models').addEventListener('change', () => {
  for (const o of objects) o.mesh.visible = $('show-models').checked;
  if (highlightMesh) highlightMesh.visible = $('show-models').checked;
});

window.addEventListener('resize', () => {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
});

// ------------------------------------------------------------------- start

syncLightInputs();
syncAimInputs();
refreshValueLabels();

// console/testing hook
window.__sro = { scene, camera, objects, selectFace, trace, lightGroup, aimTarget };

(function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
})();
