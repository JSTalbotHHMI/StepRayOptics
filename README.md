# StepRayOptics

Interactive geometric-optics sandbox: import STEP files (or add procedural demo
shapes), shine one or more light sources through them, and watch rays refract,
reflect, and convert wavelength in 3D — traced against the exact analytic B-rep
surfaces, not a triangle approximation.

Runs entirely in the browser — STEP parsing and all ray/surface intersection is done
by full OpenCascade compiled to WebAssembly (`opencascade.js`), rendering by three.js.
This is the same B-rep engine as the sibling `InventorRayOptics` project (`occt.js`,
`brepTracer.js`, `optics.js`, `lights.js`, `angularProfile.js`, `spectralBands.js`,
`materials.js` are shared verbatim between the two — no Inventor dependency in any of
them). All libraries are vendored locally, so it works offline.

## Running

Double-click **`StartStepRayOptics.bat`** (starts a local web server on port 8341 and
opens your browser).

Any static file server works, e.g. `python serve.py 8341` or `npx serve` from this
folder. A server is required — browsers won't load WASM/ES modules from `file://`.

## Features

### Models
- **Import multiple STEP files** (`.step`/`.stp`) into one scene, plus two built-in demo
  shapes (a dispersing triangular prism, a spherical ball lens) — both real B-rep
  solids (`BRepPrimAPI`), not placeholder meshes. Every loaded solid is independently
  removable ("remove" button in the Bodies list); a multi-solid STEP file becomes
  several independently-removable bodies at that same granularity.
- Body materials, face overrides, and body-as-light-source state all survive adding or
  removing other objects in the scene — internally, every object is tracked by a stable
  ID separate from the ray tracer's own body/face numbering (which just reflects
  traversal order over whatever's currently loaded, and shifts on add/remove).

### Materials
Each body's index of refraction can be a constant, a **Cauchy** model
(n = A + B/λ² + C/λ⁴), a full **Sellmeier** model, or one of two special roles:
- **Blocker** — absorbs all light by default; a fixed/dichroic reflectivity on one of
  its surfaces still reflects that share, with the rest absorbed rather than
  transmitted (e.g. a 50% mirror on a blocker reflects 50% and absorbs 50%).
- **No Impact** — always matches the surrounding medium's index, so rays pass through
  completely unrefracted; surface conditions on its faces still apply normally.

Presets are included for N-BK7, fused silica, sapphire, N-SF11 flint, water, PMMA,
polycarbonate, and two **YAG:Ce³⁺ phosphor hosts** (borosilicate glass and sintered
ceramic — see Phosphor below). Any material — custom or preset — can also have bulk
phosphor conversion enabled independently. Save any body's current material to **My
Materials** (persisted in this browser via localStorage) and reuse it on any other
body, in this session or a future one.

### Surfaces
Click any surface in the 3D view to select it (STEP B-rep faces are preserved exactly,
so you select true CAD surfaces via analytic evaluation, not triangles). Modes:
- **Auto (Fresnel equations)** — the physical, wavelength-independent dielectric
  reflectance (default).
- **Fixed reflectivity** — a flat 0–1 scalar (1.0 = perfect mirror).
- **Dichroic mirror** — reflects wavelengths within one or more Gaussian bands
  (center + FWHM bandwidth), transmits the rest.
- **Phosphor (reflective)** — absorbs light within excitation bands and re-emits it
  diffusely (Lambertian) at a resampled wavelength from the emission bands.
- **Map** — records every ray that hits the surface as a splat heatmap (color from
  wavelength, brightness from energy), rebuilt fresh each trace. **Block** (default on)
  absorbs the ray there; off, the ray passes straight through unperturbed so several
  maps can be stacked and seen through each other. A **Transparency** slider blends the
  splat overlay live, no retrace needed.

### Light sources
Any number of lights, each independently configurable:
- **Point** — free-floating, dragged with a Move/Rotate gizmo (rotation sets the aim
  direction for "Cone, custom aim" mode — an orange arrow shows it).
- **Body as light source** — convert any body into a light instead of an optical
  element (its material dropdown has a "Light Source" option), emitting from its true
  volumetric centroid ("Point"), selected surfaces, or the whole body.
  - "Selected surfaces" emission: **Normal**, **Angle from Normal** (a cone half-angle
    slider), or **Custom Profile**.
  - "Whole body" always emits along each point's own surface normal.
- **Light mode**: a single exact wavelength; **Wavelength + bandwidth** (a Gaussian
  peak — center + FWHM, for a realistic single LED/laser line); or **Custom Spectrum**
  (a hand-drawn wavelength-vs-intensity curve over an editable nm range, instead of
  assuming a flat distribution).
- **Custom angular profile** — draw an angle-vs-intensity curve (like a datasheet
  far-field pattern) for any point-like or surface emitter. Ray **density** (not
  per-ray brightness) follows the curve via true importance sampling, so every ray
  still carries equal energy and total emitted power stays constant regardless of the
  curve's shape.
- **Intensity** is the light's total power output, divided evenly across all emitted
  rays and spectral samples — raising ray count or sample count dims individual rays,
  not the total.

### Tracing
- **Ray Tracing ON/OFF** toggle at the top, off by default — configure lights/
  materials/surfaces freely before paying for any retrace.
- Max bounces and a minimum-intensity cutoff; total internal reflection is handled.
  At every hit the ray splits into reflected/refracted branches per Snell's law (or is
  absorbed/converted/recorded per the surface mode above).
- "Surrounding n" sets the ambient medium's index (1 = air/vacuum, 1.33 = water, etc.).

### View
Left-drag orbit, right-drag pan, scroll zoom, Fit View, grid/model visibility toggles,
independent **Show rays** / **Show maps** visibility toggles (hide without deleting —
instant, no retrace), and "Show control widgets" to hide all gizmos/markers for a clean
screenshot-ready view.

### Settings
**Save Settings** downloads a JSON file with every body/surface/light setting; **Load
Settings** restores from one. There's no host application to attach named snapshots to
here (unlike InventorRayOptics' per-document files), so this is a plain file
export/import — good for "save before closing the tab, reload the same objects, load
it back".

## Physics notes

- The space outside all bodies defaults to n = 1 (air/vacuum) but is adjustable via
  "Surrounding n" (e.g. 1.33 to immerse the system in water) — a **No Impact** body
  always matches whatever this is currently set to.
- Fresnel reflectance and Snell refraction both use the wavelength-dependent n(λ), so
  chromatic effects (dispersion, chromatic aberration of lenses) are physical.
- Bulk phosphor conversion is a true volumetric (Beer-Lambert) process: absorption
  probability grows with path length through the material, via a per-segment
  free-flight sample — not a flat per-entry chance — so it automatically handles
  internal TIR bounces and partial-thickness paths correctly.
- A **Blocker** body is otherwise non-absorbing-dielectric physics with reflection
  forced off by default (0, not the physical Fresnel value) unless a face override sets
  one; nothing ever transmits into a blocker regardless.
- Whether a ray is entering or leaving a solid is decided by the surface normal
  direction at the hit point, so STEP solids must be closed and consistently oriented
  (normal CAD exports are).
- Overlapping/nested solids are not tracked as a medium stack; keep solids disjoint for
  physically meaningful results.

## Known limitation

Loaded objects can't currently be moved/rotated/scaled interactively (an earlier
version of this tool supported that via a per-model transform gizmo). Preserving it
under the current B-rep engine would mean re-transforming each object's actual B-rep
shape — not just its display mesh — and rebuilding the merged scene on every drag,
which hasn't been implemented yet. Position objects by importing them already placed
correctly in your STEP export, or by using the light sources' own position/rotation
instead.

## Project layout

```
index.html            UI layout
style.css              styling
js/app.js               scene, camera, controls, UI wiring — the biggest file
js/occt.js              OpenCascade WASM loading, STEP reading, B-rep face-table
                         construction, display-mesh tessellation
js/brepTracer.js        the ray tracer itself — analytic B-rep intersection
                         (GeomAPI_IntCS/GeomLProp_SLProps), Snell/Fresnel/TIR,
                         surface phosphor, volumetric (Beer-Lambert) phosphor,
                         Blocker absorption, Map hit recording
js/optics.js            pure optics math: wavelength->RGB, emission direction
                         patterns (uniform, cone, profile-weighted, cosine-weighted,
                         isotropic), Fresnel/Snell bounce math
js/lights.js            light-source data model, default-light lifecycle
js/angularProfile.js    angle/wavelength-vs-intensity curve editor + importance
                         sampling (shared by angular profiles and Custom Spectrum)
js/spectralBands.js     Gaussian dichroic/phosphor band math + list editor
js/materials.js         dispersion models (constant/Cauchy/Sellmeier), Blocker/No
                         Impact, phosphor config, glass + YAG:Ce³⁺ presets
js/sceneModel.js         multi-object model management (StepRayOptics-specific —
                         InventorRayOptics only ever has one shape per document):
                         tracks independently-loaded/removable solids, merges them
                         into one compound for occt.js/brepTracer.js, and builds the
                         demo shapes (BRepPrimAPI)
vendor/                 three.js, opencascade.js (WASM) — offline copies
samples/                example STEP files for testing
```

A debugging hook is exposed in the browser console as `window.__sro` (`scene`,
`camera`, `oc`, `faceTable`, `lights`, `lightObjects`, `selectFace`, `trace`, `addLight`,
`removeLight`, `importStepFiles`, `addDemoShape`, `removeSceneObject`,
`serializeSettings`, `applySettings`, `setTracingEnabled`, `materialLibrary`).
