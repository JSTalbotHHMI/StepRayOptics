import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { loadStepFile, makeDemoPrism, makeDemoSphere } from './loader.js';
import { traceRays, buildRayLines, emissionDirections, wavelengthToRGB } from './tracer.js';

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
    wavelength: Number($('wavelength').value),
    intensity: Number($('intensity').value),
    rayCount: rayCountFromSlider(Number($('ray-count').value)),
    emissionMode: $('emission-mode').value,
    coneAngle: Number($('cone-angle').value),
    maxBounces: Number($('max-bounces').value),
    minIntensity: Number($('min-intensity').value),
  };
}

function refreshValueLabels() {
  const p = currentParams();
  $('wavelength-val').textContent = p.wavelength;
  $('intensity-val').textContent = p.intensity.toFixed(2);
  $('ray-count-val').textContent = p.rayCount;
  $('cone-angle-val').textContent = p.coneAngle;
  $('max-bounces-val').textContent = p.maxBounces;
  $('min-intensity-val').textContent = p.minIntensity.toFixed(3);
  const [r, g, b] = wavelengthToRGB(p.wavelength);
  $('wl-swatch').style.background =
    `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
  $('cone-row').style.display = p.emissionMode === 'cone' ? 'flex' : 'none';
}

function syncLightInputs() {
  $('light-x').value = lightGroup.position.x.toFixed(1);
  $('light-y').value = lightGroup.position.y.toFixed(1);
  $('light-z').value = lightGroup.position.z.toFixed(1);
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
    label.textContent = 'IOR';
    const ior = document.createElement('input');
    ior.type = 'number';
    ior.step = '0.01';
    ior.min = '1';
    ior.value = obj.ior;
    ior.addEventListener('change', () => {
      obj.ior = Math.max(1, Number(ior.value) || 1);
      ior.value = obj.ior;
      requestTrace();
    });

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = 'remove';
    del.addEventListener('click', () => removeObject(obj));

    row.append(label, ior, del);
    item.append(name, row);
    list.appendChild(item);
  }
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
  if (gizmo.dragging || gizmo.axis) return; // interacting with the light gizmo

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
  let axis = modelsCenter().sub(origin);
  if (axis.lengthSq() < 1e-9) axis.set(-1, 0, 0);
  const directions = emissionDirections(p.rayCount, p.emissionMode, axis, p.coneAngle);

  const result = traceRays(objects, {
    origin,
    directions,
    maxBounces: p.maxBounces,
    minIntensity: p.minIntensity,
    maxDist: sceneDiag * 1.5,
    eps: Math.max(sceneDiag * 1e-5, 1e-5),
  });

  const rgb = wavelengthToRGB(p.wavelength);
  rayLines = buildRayLines(result.segments, rgb, p.intensity);
  scene.add(rayLines);

  glow.color.setRGB(rgb[0], rgb[1], rgb[2]);
  glow.intensity = p.intensity * sceneDiag * 0.5;
  lightMarker.material.color.setRGB(
    0.5 + rgb[0] * 0.5, 0.5 + rgb[1] * 0.5, 0.5 + rgb[2] * 0.5
  );

  const s = result.stats;
  $('trace-stats').textContent =
    `${s.raysEmitted} rays → ${s.segments.toLocaleString()} segments, ` +
    `depth ≤ ${s.maxDepthReached}, ${s.timeMs.toFixed(0)} ms` +
    (s.capped ? ' (segment cap hit — lower ray count or bounces)' : '');
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

for (const id of ['wavelength', 'intensity', 'ray-count', 'cone-angle', 'max-bounces', 'min-intensity']) {
  $(id).addEventListener('input', requestTrace);
}
$('emission-mode').addEventListener('change', requestTrace);
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
refreshValueLabels();

// console/testing hook
window.__sro = { scene, camera, objects, selectFace, trace, lightGroup };

(function animate() {
  requestAnimationFrame(animate);
  orbit.update();
  renderer.render(scene, camera);
})();
