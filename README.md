# StepRayOptics

Interactive geometric-optics sandbox: import STEP files, shine a point light source
through them, and watch rays refract and reflect in 3D.

Runs entirely in the browser — STEP parsing is done by OpenCascade compiled to
WebAssembly (`occt-import-js`), rendering by three.js, and ray/mesh intersection is
accelerated with a BVH (`three-mesh-bvh`). All libraries are vendored locally, so it
works offline.

## Running

Double-click **`StartStepRayOptics.bat`** (starts a local web server on port 8341 and
opens your browser).

Any static file server works, e.g. `python -m http.server 8341` or `npx serve` from
this folder. A server is required — browsers won't load WASM/ES modules from `file://`.

## Features

- **Import multiple STEP files** (`.step`/`.stp`) into one scene. Each file gets its own
  index of refraction, editable in the Models list. Two demo shapes (dispersing prism,
  ball lens) are built in for quick experiments.
- **Per-surface reflectivity** — click any surface in the 3D view to select it
  (STEP B-rep faces are preserved, so you select true CAD surfaces, not triangles).
  By default each surface uses the exact unpolarized **Fresnel equations**; uncheck
  "Auto" to set a fixed reflectivity 0–1 (1.0 = perfect mirror, no transmission).
- **Point light source** — drag it with the gizmo or type XYZ coordinates. Control:
  - **Wavelength** (380–750 nm) — sets the rendered ray color
  - **Intensity** — brightness scaling of the rays
  - **Ray count** (10–20,000, log slider) — rays are distributed evenly
    (Fibonacci spiral) over a full sphere or over a cone aimed at the models
- **Tracing controls** — max bounces and a minimum-intensity cutoff. At every surface
  hit the ray splits into a reflected and refracted branch per Snell's law; total
  internal reflection is handled. Branch energy falls off with each split, and rays
  dimmer than the cutoff are dropped.
- **View** — left-drag orbit, right-drag pan, scroll zoom, Fit View button,
  grid/model visibility toggles.

## Physics notes

- Media are treated as non-absorbing dielectrics; the space outside models is air (n = 1).
- Whether a ray is entering or leaving a solid is decided by the surface normal
  direction at the hit point, so STEP solids must be closed and consistently oriented
  (normal CAD exports are).
- Wavelength currently affects only the displayed color — dispersion is not modeled
  (IOR is a single number per model). To see prism dispersion, trace once per
  wavelength with the IOR adjusted manually.
- Overlapping/nested solids are not tracked as a medium stack; keep solids disjoint
  for physically meaningful results.

## Project layout

```
index.html          UI layout
style.css           styling
js/app.js           scene, camera, controls, UI wiring
js/tracer.js        ray-tracing core (Snell, Fresnel, TIR, emission patterns)
js/loader.js        STEP import (occt-import-js) + demo geometry
vendor/             three.js, three-mesh-bvh, occt-import-js (WASM) — offline copies
samples/            example STEP files for testing
```

A debugging hook is exposed in the browser console as `window.__sro`
(`objects`, `camera`, `selectFace`, `trace`, `lightGroup`).
