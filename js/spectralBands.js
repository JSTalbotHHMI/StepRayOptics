// Gaussian spectral bands, shared by dichroic mirrors and both phosphor features.
// A band is { center, bandwidth } — `bandwidth` is the FWHM (full width at half
// maximum) in nm, giving a realistic soft-edged transition rather than a hard cutoff
// (real dichroic coatings and phosphor excitation/emission curves both look like this).

export function gaussianWeight(center, fwhm, wavelength) {
  if (fwhm <= 0) return wavelength === center ? 1 : 0;
  const sigmaFactor = 4 * Math.LN2; // exp(-sigmaFactor * dλ²/fwhm²) = 0.5 at dλ = fwhm/2
  const d = wavelength - center;
  return Math.exp(-sigmaFactor * d * d / (fwhm * fwhm));
}

// Multi-band reflectance for a dichroic coating: each band contributes independently
// (so overlapping bands combine into a wider or taller reflect region), summed then
// clamped to a physical [0, 1] reflectance.
export function sumBandsClamped(bands, wavelength) {
  let sum = 0;
  for (const b of bands) sum += gaussianWeight(b.center, b.bandwidth, wavelength);
  return Math.min(1, sum);
}

// Box-Muller sample from a Gaussian with the given center and FWHM — used to pick a
// converted photon's new wavelength from a phosphor's emission band (Phase 6/7).
export function sampleGaussian(center, fwhm) {
  const sigma = fwhm / (2 * Math.sqrt(2 * Math.LN2));
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return center + z * sigma;
}

export function defaultBand() {
  return { center: 550, bandwidth: 40 };
}

// Generic starting point for "add phosphor conversion to this surface" (a flat
// per-hit probability — see brepTracer.js) — loosely YAG:Ce-like (blue excitation,
// broad yellow emission) since that's by far the most common real phosphor, but a
// generic default, not the exact YAG:Ce³⁺ preset values (see materials.js).
export function defaultPhosphorConfig() {
  return {
    excitationBands: [{ center: 460, bandwidth: 40 }],
    emissionBands: [{ center: 555, bandwidth: 100 }],
    efficiency: 0.85,
  };
}

// Same, but for a bulk material's volumetric conversion (Phase 7), which additionally
// needs `conversionDepth` (mm) — the mean path length before an excitable photon
// converts (Beer-Lambert free-flight sampling, not a flat per-hit probability).
export function defaultVolumePhosphorConfig() {
  return { ...defaultPhosphorConfig(), conversionDepth: 1.0 };
}

// Picks a converted photon's new wavelength: choose one emission band at random (for
// multi-band phosphors), then sample its Gaussian.
export function sampleEmissionWavelength(emissionBands) {
  const band = emissionBands[Math.floor(Math.random() * emissionBands.length)];
  return sampleGaussian(band.center, band.bandwidth);
}

/**
 * A reusable add/remove/edit list of {center, bandwidth} bands. `bands` is mutated in
 * place; `onChange(bands)` fires on every edit. Returns the container element.
 */
export function createBandListEditor(bands, onChange, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'band-list';

  function render() {
    wrap.innerHTML = '';
    bands.forEach((band, i) => {
      const row = document.createElement('div');
      row.className = 'band-row';

      const centerInput = document.createElement('input');
      centerInput.type = 'number'; centerInput.className = 'nm';
      centerInput.min = 380; centerInput.max = 750; centerInput.step = 5;
      centerInput.value = band.center;
      centerInput.title = 'Center wavelength (nm)';
      centerInput.addEventListener('change', () => {
        band.center = Number(centerInput.value) || band.center;
        onChange(bands);
      });

      const bwInput = document.createElement('input');
      bwInput.type = 'number'; bwInput.className = 'nm';
      bwInput.min = 1; bwInput.max = 400; bwInput.step = 5;
      bwInput.value = band.bandwidth;
      bwInput.title = 'Bandwidth, FWHM (nm)';
      bwInput.addEventListener('change', () => {
        band.bandwidth = Math.max(1, Number(bwInput.value) || band.bandwidth);
        onChange(bands);
      });

      const label1 = document.createElement('span');
      label1.className = 'muted small'; label1.textContent = 'nm ±';
      const removeBtn = document.createElement('button');
      removeBtn.className = 'del';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove band';
      removeBtn.disabled = bands.length <= 1 && options.minOne;
      removeBtn.addEventListener('click', () => {
        bands.splice(i, 1);
        render();
        onChange(bands);
      });

      row.append(centerInput, label1, bwInput, removeBtn);
      wrap.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add band';
    addBtn.addEventListener('click', () => {
      bands.push(defaultBand());
      render();
      onChange(bands);
    });
    wrap.appendChild(addBtn);
  }

  render();
  return wrap;
}
