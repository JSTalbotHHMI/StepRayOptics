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
  material, editable in the Models list. Two demo shapes (dispersing prism, ball lens)
  are built in for quick experiments.
- **Position models freely** — every model has Move / Rotate / Scale buttons that attach
  a drag gizmo in the viewport (click again to dismiss, Reset restores the original
  placement). Ray physics and surface picking follow the transform.
- **Dispersive materials** — each model's index of refraction can be a constant, a
  **Cauchy** model (n = A + B/λ² + C/λ⁴), or a full **Sellmeier** model. Presets are
  included for N-BK7, fused silica, sapphire, N-SF11 flint, water, PMMA, and
  polycarbonate; all coefficients are editable, and the list shows the resulting n(λ)
  at the current wavelength.
- **Per-surface reflectivity** — click any surface in the 3D view to select it
  (STEP B-rep faces are preserved, so you select true CAD surfaces, not triangles).
  By default each surface uses the exact unpolarized **Fresnel equations**; uncheck
  "Auto" to set a fixed reflectivity 0–1 (1.0 = perfect mirror, no transmission).
- **Point light source** — drag it with the gizmo or type XYZ coordinates. Control:
  - **Light mode** — a single wavelength (380–750 nm), or a **spectrum**: pick a
    wavelength range and sample count, and the same ray fan is traced once per
    wavelength with each model's n(λ). Spectral rays share a path until refraction
    separates them, so dispersive glass produces real rainbows.
  - **Intensity** — the source's total power output. It is divided evenly across
    all emitted rays (and spectral samples), so raising the ray count dims each
    individual ray while the total light in the scene stays constant.
  - **Ray count** (10–20,000, log slider) — rays are distributed evenly
    (Fibonacci spiral) over a full sphere or over a cone. The cone can aim
    automatically at the models, or at a custom aim point set by XYZ inputs or by
    dragging the orange aim marker (the cone keeps pointing at it as the light moves)
- **Tracing controls** — max bounces and a minimum-intensity cutoff. At every surface
  hit the ray splits into a reflected and refracted branch per Snell's law; total
  internal reflection is handled. Branch energy falls off with each split, and rays
  dimmer than the cutoff are dropped.
- **View** — left-drag orbit, right-drag pan, scroll zoom, Fit View button,
  grid/model visibility toggles, and a "Show control widgets" toggle that hides all
  drag gizmos and markers for a clean screenshot-ready view.

## Physics notes

- Media are treated as non-absorbing dielectrics; the space outside models is air (n = 1).
- Whether a ray is entering or leaving a solid is decided by the surface normal
  direction at the hit point, so STEP solids must be closed and consistently oriented
  (normal CAD exports are).
- Fresnel reflectance and Snell refraction both use the wavelength-dependent n(λ),
  so chromatic effects (dispersion, chromatic aberration of lenses) are physical.
- Overlapping/nested solids are not tracked as a medium stack; keep solids disjoint
  for physically meaningful results.

## Project layout

```
index.html          UI layout
style.css           styling
js/app.js           scene, camera, controls, UI wiring
js/tracer.js        ray-tracing core (Snell, Fresnel, TIR, emission patterns)
js/materials.js     dispersion models (constant/Cauchy/Sellmeier) + glass presets
js/loader.js        STEP import (occt-import-js) + demo geometry
vendor/             three.js, three-mesh-bvh, occt-import-js (WASM) — offline copies
samples/            example STEP files for testing
```

A debugging hook is exposed in the browser console as `window.__sro`
(`objects`, `camera`, `selectFace`, `trace`, `lightGroup`).
