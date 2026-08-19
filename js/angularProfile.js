// Generic X-vs-intensity curve editor, shared by two features:
//   - angle-vs-intensity emission profiles (point/surface/body light sources, domain
//     always fixed 0-90°) so a light can match a real far-field datasheet curve instead
//     of emitting uniformly within its cone.
//   - wavelength-vs-intensity spectral profiles ("Custom Spectrum" light mode, domain
//     the light's own specMin..specMax) so a light's spectral power distribution can be
//     hand-drawn instead of assumed flat across its range.
//
// A profile is either `null` (uniform — every sample carries full weight) or
// `{ points: [{x, intensity}, ...] }`, sorted by ascending x, intensity in [0, 1]. The
// curve is piecewise-linear between points (no spline overshoot — a wobbly
// interpolation would misrepresent a monotonic datasheet falloff); intensity outside
// the defined range clamps to the nearest endpoint.
//
// Applied as a per-sample ENERGY weight at generation time (see app.js's trace()), not
// by changing how densely rays/wavelengths are sampled — this keeps the existing
// uniform-density generators untouched and composes directly with the existing
// power-conservation gain formula: a dim angle/wavelength produces a dimmer, not a
// rarer, sample.

export function sampleProfile(profile, x) {
  if (!profile || !profile.points || profile.points.length === 0) return 1;
  const pts = profile.points;
  const ax = Math.abs(x);
  if (ax <= pts[0].x) return pts[0].intensity;
  for (let i = 1; i < pts.length; i++) {
    if (ax <= pts[i].x) {
      const p0 = pts[i - 1], p1 = pts[i];
      const span = p1.x - p0.x;
      const t = span > 1e-9 ? (ax - p0.x) / span : 0;
      return p0.intensity + (p1.intensity - p0.intensity) * t;
    }
  }
  return pts[pts.length - 1].intensity;
}

export function defaultProfile(minX, maxX) {
  return { points: [{ x: minX, intensity: 1 }, { x: maxX, intensity: 1 }] };
}

/**
 * Builds a discretized inverse-CDF for importance-sampling emission ANGLE from a
 * profile, so ray DENSITY (not per-ray energy) matches the curve's shape — every
 * sampled ray then carries the same fixed energy. The density at angle θ is weighted
 * by sin(θ) (the solid-angle Jacobian: a ring at θ spans solid angle proportional to
 * sin(θ) dθ across the full azimuth), so a profile value alone isn't the sampling
 * density — without that correction, angles near 0° would always be over-represented
 * relative to what the profile's shape actually implies about power per solid angle.
 * Build once per light per trace (not per ray) via `binCount` discretization, then
 * call `.sampleAngleDeg()` cheaply for every ray.
 */
export function buildAngleSampler(profile, maxAngleDeg, binCount = 256) {
  const bins = new Array(binCount);
  let cumulative = 0;
  for (let i = 0; i < binCount; i++) {
    const theta = ((i + 0.5) / binCount) * maxAngleDeg;
    const weight = Math.max(0, sampleProfile(profile, theta)) * Math.sin(theta * Math.PI / 180);
    cumulative += weight;
    bins[i] = { theta, cumulative };
  }
  const total = cumulative > 1e-12 ? cumulative : 1;
  return {
    sampleAngleDeg() {
      const target = Math.random() * total;
      let lo = 0, hi = bins.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (bins[mid].cumulative < target) lo = mid + 1; else hi = mid;
      }
      return bins[lo].theta;
    },
  };
}

const PAD = { left: 28, right: 8, top: 8, bottom: 20 };
const POINT_RADIUS = 5;

/**
 * Builds a small canvas-based curve editor over the domain [minX, maxX]. Returns a
 * wrapper <div> plus a `setRange(min, max)` hook for callers whose domain can change
 * live (the "Custom Spectrum" light mode's specMin/specMax fields) — angular-profile
 * callers have a fixed 0-90° domain and simply never call it.
 *
 * The canvas's intrinsic drawing buffer stays fixed-size for crisp, simple coordinate
 * math; its CSS box scales to fill whatever container it's placed in (`canvas.style.width
 * = 100%`), so it never overflows a narrow sidebar the way a hardcoded pixel width did.
 * Pointer handlers convert through the actual displayed size via getBoundingClientRect
 * so clicking/dragging stays accurate regardless of the CSS-scaled size.
 */
export function createProfileEditor(profile, minX, maxX, onChange, options = {}) {
  const formatX = options.formatX || ((v) => Math.round(v).toString());

  const wrap = document.createElement('div');
  wrap.className = 'angular-profile';

  const canvas = document.createElement('canvas');
  canvas.width = 280;
  canvas.height = 110;
  canvas.style.width = '100%';
  wrap.appendChild(canvas);

  const controls = document.createElement('div');
  controls.className = 'row';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset to uniform';
  resetBtn.addEventListener('click', () => {
    profile.points = defaultProfile(minX, maxX).points;
    render();
    onChange(profile);
  });
  controls.appendChild(resetBtn);
  wrap.appendChild(controls);

  const hint = document.createElement('div');
  hint.className = 'muted small';
  hint.textContent = 'Click to add a point, drag to move, double-click to remove.';
  wrap.appendChild(hint);

  const ctx = canvas.getContext('2d');
  const plotW = () => canvas.width - PAD.left - PAD.right;
  const plotH = () => canvas.height - PAD.top - PAD.bottom;
  const range = () => Math.max(1e-6, maxX - minX);

  function toScreen(x, intensity) {
    return {
      x: PAD.left + ((x - minX) / range()) * plotW(),
      y: PAD.top + (1 - intensity) * plotH(),
    };
  }
  function toData(x, y) {
    const dx = Math.max(minX, Math.min(maxX, minX + ((x - PAD.left) / plotW()) * range()));
    const intensity = Math.max(0, Math.min(1, 1 - (y - PAD.top) / plotH()));
    return { x: dx, intensity };
  }
  // pointer events give CSS-pixel coordinates; the canvas's drawing buffer (what
  // toScreen/toData operate in) can be a different size once CSS scales its box — scale
  // through the ratio so hit-testing/dragging stays correct at any displayed size.
  function eventToCanvasXY(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#10151b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // gridlines + axis labels
    ctx.strokeStyle = '#232b34';
    ctx.fillStyle = '#6c7c8c';
    ctx.font = '9px sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = PAD.top + (i / 4) * plotH();
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW(), y); ctx.stroke();
      ctx.fillText((1 - i / 4).toFixed(2), 2, y + 3);
    }
    for (let i = 0; i <= 4; i++) {
      const x = PAD.left + (i / 4) * plotW();
      ctx.beginPath(); ctx.moveTo(x, PAD.top); ctx.lineTo(x, PAD.top + plotH()); ctx.stroke();
      ctx.fillText(formatX(minX + (i / 4) * range()), x - 10, canvas.height - 6);
    }

    // curve
    const pts = profile.points;
    ctx.strokeStyle = '#2d7ab8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = toScreen(p.x, p.intensity);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    ctx.stroke();

    // control points
    ctx.fillStyle = '#7ec8ff';
    for (const p of pts) {
      const s = toScreen(p.x, p.intensity);
      ctx.beginPath();
      ctx.arc(s.x, s.y, POINT_RADIUS, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function nearestPointIndex(x, y) {
    let best = -1, bestDist = POINT_RADIUS + 3;
    profile.points.forEach((p, i) => {
      const s = toScreen(p.x, p.intensity);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  }

  let draggingIndex = -1;
  canvas.addEventListener('pointerdown', (e) => {
    const { x, y } = eventToCanvasXY(e);
    draggingIndex = nearestPointIndex(x, y);
    if (draggingIndex < 0) {
      const point = toData(x, y);
      profile.points.push(point);
      profile.points.sort((a, b) => a.x - b.x);
      draggingIndex = profile.points.findIndex((p) => p.x === point.x && p.intensity === point.intensity);
      render();
      onChange(profile);
    }
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (draggingIndex < 0) return;
    const { x, y } = eventToCanvasXY(e);
    profile.points[draggingIndex] = toData(x, y);
    render();
    onChange(profile);
  });
  canvas.addEventListener('pointerup', () => {
    if (draggingIndex < 0) return;
    profile.points.sort((a, b) => a.x - b.x);
    draggingIndex = -1;
    render();
    onChange(profile);
  });
  canvas.addEventListener('dblclick', (e) => {
    if (profile.points.length <= 2) return; // always keep at least the two endpoints
    const { x, y } = eventToCanvasXY(e);
    const idx = nearestPointIndex(x, y);
    if (idx >= 0) {
      profile.points.splice(idx, 1);
      render();
      onChange(profile);
    }
  });

  render();
  return {
    element: wrap,
    setRange(newMin, newMax) { minX = newMin; maxX = newMax; render(); },
  };
}
