// Texture format metadata.
//
// `expect` is what the WebGPU spec says should be true. It is not a value we
// trust — it is the baseline we compare measurements against to find where an
// implementation diverges.

export type FormatKind = 'color' | 'depth' | 'compressed';

export interface FormatMeta {
  format: string;
  kind: FormatKind;
  /** Texel type of the WGSL texture */
  texel: 'f32' | 'u32' | 'i32';
  /** Whether a filtering sampler may be attached (decides bindGroupLayout sampleType) */
  filterable: boolean;
  /** The device feature this format requires */
  requiresFeature?: string;
  /** Block size for compressed formats — createTexture must be a multiple of it */
  block?: [number, number];
  hasDepth?: boolean;
  hasStencil?: boolean;
  /** What the spec says to expect */
  expect: {
    renderable: boolean;
    blendable: boolean;
    storage: boolean;
  };
}

const color = (
  format: string,
  texel: 'f32' | 'u32' | 'i32',
  filterable: boolean,
  expect: { renderable: boolean; blendable: boolean; storage: boolean },
  requiresFeature?: string,
): FormatMeta => ({ format, kind: 'color', texel, filterable, expect, requiresFeature });

const NO = { renderable: false, blendable: false, storage: false };
const R_B = { renderable: true, blendable: true, storage: false };
const R__ = { renderable: true, blendable: false, storage: false };
const R_BS = { renderable: true, blendable: true, storage: true };
const R__S = { renderable: true, blendable: false, storage: true };
const ___S = { renderable: false, blendable: false, storage: true };

export const FORMATS: FormatMeta[] = [
  // ── 8-bit ──
  color('r8unorm', 'f32', true, R_B),
  color('r8snorm', 'f32', true, NO),
  color('r8uint', 'u32', false, R__),
  color('r8sint', 'i32', false, R__),

  // ── 16-bit ──
  color('r16uint', 'u32', false, R__),
  color('r16sint', 'i32', false, R__),
  color('r16float', 'f32', true, R_B),
  color('rg8unorm', 'f32', true, R_B),
  color('rg8snorm', 'f32', true, NO),
  color('rg8uint', 'u32', false, R__),
  color('rg8sint', 'i32', false, R__),

  // ── 32-bit ──
  color('r32uint', 'u32', false, R__S),
  color('r32sint', 'i32', false, R__S),
  // r32float renders but does not blend without float32-blendable
  color('r32float', 'f32', false, R__S),
  color('rg16uint', 'u32', false, R__),
  color('rg16sint', 'i32', false, R__),
  color('rg16float', 'f32', true, R_B),
  color('rgba8unorm', 'f32', true, R_BS),
  color('rgba8unorm-srgb', 'f32', true, R_B),
  color('rgba8snorm', 'f32', true, ___S),
  color('rgba8uint', 'u32', false, R__S),
  color('rgba8sint', 'i32', false, R__S),
  color('bgra8unorm', 'f32', true, R_B),
  color('bgra8unorm-srgb', 'f32', true, R_B),
  color('rgb10a2uint', 'u32', false, R__),
  color('rgb10a2unorm', 'f32', true, R_B),
  // rg11b10ufloat rendering sits behind its own feature gate
  color('rg11b10ufloat', 'f32', true, NO),

  // ── 64-bit ──
  color('rg32uint', 'u32', false, R__S),
  color('rg32sint', 'i32', false, R__S),
  color('rg32float', 'f32', false, R__S),
  color('rgba16uint', 'u32', false, R__S),
  color('rgba16sint', 'i32', false, R__S),
  color('rgba16float', 'f32', true, R_BS),

  // ── 128-bit ──
  color('rgba32uint', 'u32', false, R__S),
  color('rgba32sint', 'i32', false, R__S),
  color('rgba32float', 'f32', false, R__S),

  // ── Depth / stencil ──
  {
    format: 'stencil8', kind: 'depth', texel: 'u32', filterable: false,
    hasStencil: true, expect: R__,
  },
  {
    format: 'depth16unorm', kind: 'depth', texel: 'f32', filterable: false,
    hasDepth: true, expect: R__,
  },
  {
    format: 'depth24plus', kind: 'depth', texel: 'f32', filterable: false,
    hasDepth: true, expect: R__,
  },
  {
    format: 'depth24plus-stencil8', kind: 'depth', texel: 'f32', filterable: false,
    hasDepth: true, hasStencil: true, expect: R__,
  },
  {
    format: 'depth32float', kind: 'depth', texel: 'f32', filterable: false,
    hasDepth: true, expect: R__,
  },
  {
    format: 'depth32float-stencil8', kind: 'depth', texel: 'f32', filterable: false,
    hasDepth: true, hasStencil: true, requiresFeature: 'depth32float-stencil8',
    expect: R__,
  },

  // ── Compressed: BC (desktop) ──
  ...compressed(['bc1-rgba-unorm', 'bc3-rgba-unorm', 'bc4-r-unorm', 'bc5-rg-unorm',
    'bc6h-rgb-ufloat', 'bc7-rgba-unorm'], 'texture-compression-bc', [4, 4]),

  // ── Compressed: ETC2 (mobile) ──
  ...compressed(['etc2-rgb8unorm', 'etc2-rgba8unorm', 'eac-r11unorm'],
    'texture-compression-etc2', [4, 4]),

  // ── Compressed: ASTC (mobile) ──
  ...compressed(['astc-4x4-unorm'], 'texture-compression-astc', [4, 4]),
  ...compressed(['astc-8x8-unorm'], 'texture-compression-astc', [8, 8]),
];

function compressed(
  formats: string[],
  feature: string,
  block: [number, number],
): FormatMeta[] {
  return formats.map((format) => ({
    format,
    kind: 'compressed' as const,
    texel: 'f32' as const,
    filterable: true,
    requiresFeature: feature,
    block,
    expect: NO,
  }));
}

export function findMeta(format: string): FormatMeta | undefined {
  return FORMATS.find((f) => f.format === format);
}

// ── Feature-adjusted expectations ───────────────────────
//
// WebGPU widens format capabilities through features. The `expect` values above
// are core-spec baselines, so using them unadjusted on a device with features
// enabled produces a flood of false "more permissive than spec" reports. Raise
// the baseline by whatever the device declares, then compare — what is left is
// real divergence.

/** Formats that texture-formats-tier1 grants storage binding to */
const TIER1_STORAGE = new Set([
  'r8unorm', 'r8snorm', 'r8uint', 'r8sint',
  'rg8unorm', 'rg8snorm', 'rg8uint', 'rg8sint',
  'r16uint', 'r16sint', 'r16float',
  'rg16uint', 'rg16sint', 'rg16float',
  'rgb10a2unorm', 'rgb10a2uint', 'rg11b10ufloat',
]);

/** 32-bit float color formats — float32-blendable grants them blending */
const FLOAT32_COLOR = new Set(['r32float', 'rg32float', 'rgba32float']);

export function expectationsFor(
  meta: FormatMeta,
  features: Set<string>,
): FormatMeta['expect'] {
  const e = { ...meta.expect };

  if (features.has('texture-formats-tier1') && TIER1_STORAGE.has(meta.format)) {
    e.storage = true;
  }
  if (features.has('rg11b10ufloat-renderable') && meta.format === 'rg11b10ufloat') {
    e.renderable = true;
    e.blendable = true;
  }
  if (features.has('bgra8unorm-storage') && meta.format === 'bgra8unorm') {
    e.storage = true;
  }
  if (features.has('float32-blendable') && FLOAT32_COLOR.has(meta.format)) {
    e.blendable = true;
  }

  // tier2 subsumes tier1 and extends read-write storage further. The exact list
  // is still moving between implementations, so this stops at the point where
  // extra storage capability is no longer treated as a discrepancy.
  if (features.has('texture-formats-tier2') && meta.kind === 'color') {
    e.storage = e.storage || TIER1_STORAGE.has(meta.format);
  }

  return e;
}

/**
 * Whether measuring more capability than the baseline should be reported.
 * With tier features on, the extended list varies per implementation and the
 * reports are noise rather than signal.
 */
export function toleratesExtraStorage(features: Set<string>): boolean {
  return features.has('texture-formats-tier1') || features.has('texture-formats-tier2');
}

/** sampleType for the bindGroupLayout entry */
export function sampleTypeOf(meta: FormatMeta): GPUTextureSampleType {
  if (meta.kind === 'depth') {
    // Stencil-only formats are read as uint
    return meta.hasDepth ? 'depth' : 'uint';
  }
  if (meta.texel === 'u32') return 'uint';
  if (meta.texel === 'i32') return 'sint';
  return meta.filterable ? 'float' : 'unfilterable-float';
}

/** WGSL texture declaration type */
export function wgslTextureType(meta: FormatMeta): string {
  if (meta.kind === 'depth' && meta.hasDepth) return 'texture_depth_2d';
  return `texture_2d<${meta.texel}>`;
}
