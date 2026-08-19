// Wavelength-dependent index-of-refraction models, plus optional bulk phosphor
// conversion.
//
// A material is { type: 'constant'|'cauchy'|'sellmeier'|'blocker'|'noImpact', ...coefficients, phosphor }.
//   constant:  { n }
//   cauchy:    { A, B, C }        n(λ) = A + B/λ² + C/λ⁴          (λ in µm)
//   sellmeier: { B1..B3, C1..C3 } n²(λ) = 1 + Σ Bᵢλ²/(λ² − Cᵢ)    (λ in µm, Cᵢ in µm²)
//   blocker:   { n }              absorbs all light by default (see brepTracer.js —
//                                  never generates a transmitted ray); a face-level
//                                  surface condition (fixed/dichroic reflectivity) still
//                                  reflects its share, but whatever isn't reflected is
//                                  absorbed rather than transmitted. `n` is stored only
//                                  for consistency with other types — since no ray ever
//                                  transmits through a blocker, its value has no effect.
//   noImpact:  {}                 IOR always equals the CURRENT ambient IOR (the
//                                  `ambientIor` argument below), so rays pass through
//                                  completely unrefracted — a body that's physically
//                                  transparent to ray propagation. Face-level surface
//                                  conditions (reflectivity/dichroic/phosphor/map) still
//                                  apply normally; only bulk refraction is suppressed.
//
// `phosphor` is independent of `type`/IOR — any material can have it enabled, since a
// real phosphor is particles suspended in a normal refractive binder (silicone, glass).
// null = no conversion. Otherwise { excitationBands, emissionBands, efficiency,
// conversionDepth } — same band shape as spectralBands.js's dichroic/surface-phosphor
// bands, plus `conversionDepth` (mm): the mean path length before an excitable photon
// converts (see brepTracer.js's volumetric free-flight sampling).

export function iorAt(material, wavelengthNm, ambientIor = 1) {
  if (material.type === 'noImpact') return ambientIor;
  const um = wavelengthNm / 1000;
  switch (material.type) {
    case 'cauchy': {
      const l2 = um * um;
      return material.A + material.B / l2 + (material.C || 0) / (l2 * l2);
    }
    case 'sellmeier': {
      const l2 = um * um;
      const n2 = 1 +
        (material.B1 * l2) / (l2 - material.C1) +
        (material.B2 * l2) / (l2 - material.C2) +
        (material.B3 * l2) / (l2 - material.C3);
      return Math.sqrt(Math.max(1, n2));
    }
    default:
      return material.n; // 'constant' and 'blocker' both just store n directly
  }
}

export function defaultMaterial() {
  return { type: 'constant', n: 1.5, phosphor: null };
}

// Coefficients from standard glass catalogs / refractiveindex.info
export const PRESETS = {
  'N-BK7': {
    type: 'sellmeier',
    B1: 1.03961212, B2: 0.231792344, B3: 1.01046945,
    C1: 0.00600069867, C2: 0.0200179144, C3: 103.560653,
  },
  'Fused silica': {
    type: 'sellmeier',
    B1: 0.6961663, B2: 0.4079426, B3: 0.8974794,
    C1: 0.004679148, C2: 0.013512063, C3: 97.934003,
  },
  'Sapphire (ordinary)': {
    type: 'sellmeier',
    B1: 1.4313493, B2: 0.65054713, B3: 5.3414021,
    C1: 0.00527993, C2: 0.01423827, C3: 325.01783,
  },
  'N-SF11 (flint)': {
    type: 'sellmeier',
    B1: 1.73759695, B2: 0.313747346, B3: 1.89878101,
    C1: 0.013188707, C2: 0.0623068142, C3: 155.23629,
  },
  'Water': { type: 'cauchy', A: 1.3247, B: 0.003046, C: 0 },
  'PMMA (acrylic)': { type: 'cauchy', A: 1.478, B: 0.0045, C: 0 },
  'Polycarbonate': { type: 'cauchy', A: 1.5601, B: 0.00821, C: 0 },
  // YAG:Ce³⁺ (cerium-doped yttrium aluminum garnet) is the phosphor used in almost
  // every phosphor-converted white LED (blue die + YAG:Ce dome/coating -> blue+yellow
  // mixes to white). Excitation ≈460nm/40nm FWHM (blue-LED absorption peak); emission
  // ≈555nm/100nm FWHM (real YAG:Ce emission is broader and asymmetric than one
  // Gaussian — approximated here as a single wide symmetric band). Two host-material
  // presets, differing mainly in phosphor concentration (via conversionDepth):
  'YAG:Ce³⁺-doped borosilicate glass': {
    // phosphor particles diluted through a low-index glass/silicone-like host —
    // needs several mm of path to convert
    type: 'cauchy', A: 1.51, B: 0.0042, C: 0,
    phosphor: {
      excitationBands: [{ center: 460, bandwidth: 40 }],
      emissionBands: [{ center: 555, bandwidth: 100 }],
      efficiency: 0.9, conversionDepth: 2.0,
    },
  },
  'Sintered ceramic phosphor': {
    // dense polycrystalline YAG ceramic (n≈1.8 for pure YAG) — much more concentrated
    // than a diluted glass composite, converts over a much shorter path
    type: 'cauchy', A: 1.81, B: 0.01, C: 0,
    phosphor: {
      excitationBands: [{ center: 460, bandwidth: 40 }],
      emissionBands: [{ center: 555, bandwidth: 100 }],
      efficiency: 0.9, conversionDepth: 0.3,
    },
  },
};

// Editable coefficient fields per model type
export const TYPE_FIELDS = {
  constant: ['n'],
  cauchy: ['A', 'B', 'C'],
  sellmeier: ['B1', 'B2', 'B3', 'C1', 'C2', 'C3'],
  blocker: [], // n is fixed/irrelevant — nothing ever transmits through a blocker
  noImpact: [], // IOR is derived (matches ambient), not stored
};
