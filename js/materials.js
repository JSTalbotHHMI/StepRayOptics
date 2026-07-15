// Wavelength-dependent index-of-refraction models.
//
// A material is { type: 'constant'|'cauchy'|'sellmeier', ...coefficients }.
//   constant:  { n }
//   cauchy:    { A, B, C }        n(λ) = A + B/λ² + C/λ⁴          (λ in µm)
//   sellmeier: { B1..B3, C1..C3 } n²(λ) = 1 + Σ Bᵢλ²/(λ² − Cᵢ)    (λ in µm, Cᵢ in µm²)

export function iorAt(material, wavelengthNm) {
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
      return material.n;
  }
}

export function defaultMaterial() {
  return { type: 'constant', n: 1.5 };
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
};

// Editable coefficient fields per model type
export const TYPE_FIELDS = {
  constant: ['n'],
  cauchy: ['A', 'B', 'C'],
  sellmeier: ['B1', 'B2', 'B3', 'C1', 'C2', 'C3'],
};
