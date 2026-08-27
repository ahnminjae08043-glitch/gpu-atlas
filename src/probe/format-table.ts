// 텍스처 포맷 메타데이터.
//
// expect 는 "WebGPU 스펙대로라면 이래야 한다"는 값이다. 우리가 신뢰하는 값이 아니라,
// 실측 결과와 비교해서 어긋난 지점을 찾아내기 위한 기준선이다.

export type FormatKind = 'color' | 'depth' | 'compressed';

export interface FormatMeta {
  format: string;
  kind: FormatKind;
  /** WGSL 텍스처의 텍셀 타입 */
  texel: 'f32' | 'u32' | 'i32';
  /** 필터링 샘플러를 붙일 수 있는가 (bindGroupLayout 의 sampleType 결정) */
  filterable: boolean;
  /** 이 포맷을 쓰려면 필요한 device feature */
  requiresFeature?: string;
  /** 압축 포맷의 블록 크기 — createTexture 크기를 여기 맞춰야 한다 */
  block?: [number, number];
  hasDepth?: boolean;
  hasStencil?: boolean;
  /** 스펙상 기대값 */
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
  // ── 8비트 ──
  color('r8unorm', 'f32', true, R_B),
  color('r8snorm', 'f32', true, NO),
  color('r8uint', 'u32', false, R__),
  color('r8sint', 'i32', false, R__),

  // ── 16비트 ──
  color('r16uint', 'u32', false, R__),
  color('r16sint', 'i32', false, R__),
  color('r16float', 'f32', true, R_B),
  color('rg8unorm', 'f32', true, R_B),
  color('rg8snorm', 'f32', true, NO),
  color('rg8uint', 'u32', false, R__),
  color('rg8sint', 'i32', false, R__),

  // ── 32비트 ──
  color('r32uint', 'u32', false, R__S),
  color('r32sint', 'i32', false, R__S),
  // r32float 는 렌더는 되지만 블렌딩은 float32-blendable 없이는 안 된다
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
  // rg11b10ufloat 렌더는 별도 feature 게이트
  color('rg11b10ufloat', 'f32', true, NO),

  // ── 64비트 ──
  color('rg32uint', 'u32', false, R__S),
  color('rg32sint', 'i32', false, R__S),
  color('rg32float', 'f32', false, R__S),
  color('rgba16uint', 'u32', false, R__S),
  color('rgba16sint', 'i32', false, R__S),
  color('rgba16float', 'f32', true, R_BS),

  // ── 128비트 ──
  color('rgba32uint', 'u32', false, R__S),
  color('rgba32sint', 'i32', false, R__S),
  color('rgba32float', 'f32', false, R__S),

  // ── 깊이/스텐실 ──
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

  // ── 압축: BC (데스크톱 계열) ──
  ...compressed(['bc1-rgba-unorm', 'bc3-rgba-unorm', 'bc4-r-unorm', 'bc5-rg-unorm',
    'bc6h-rgb-ufloat', 'bc7-rgba-unorm'], 'texture-compression-bc', [4, 4]),

  // ── 압축: ETC2 (모바일 계열) ──
  ...compressed(['etc2-rgb8unorm', 'etc2-rgba8unorm', 'eac-r11unorm'],
    'texture-compression-etc2', [4, 4]),

  // ── 압축: ASTC (모바일 계열) ──
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

// ── feature 에 따른 기대값 확장 ──────────────────────────
//
// WebGPU 는 코어 스펙 위에 feature 로 포맷 능력을 넓힌다. 위 expect 는 코어 기준이라,
// feature 가 켜진 기기에서 그대로 쓰면 "스펙보다 관대하다"는 오탐이 쏟아진다.
// 여기서 선언된 feature 만큼 기준선을 올려준 뒤에 비교해야 진짜 불일치만 남는다.

/** texture-formats-tier1 이 스토리지 바인딩을 추가하는 포맷들 */
const TIER1_STORAGE = new Set([
  'r8unorm', 'r8snorm', 'r8uint', 'r8sint',
  'rg8unorm', 'rg8snorm', 'rg8uint', 'rg8sint',
  'r16uint', 'r16sint', 'r16float',
  'rg16uint', 'rg16sint', 'rg16float',
  'rgb10a2unorm', 'rgb10a2uint', 'rg11b10ufloat',
]);

/** 32비트 부동소수 포맷 — float32-blendable 이 블렌딩을 추가한다 */
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

  // tier2 는 tier1 을 포함하고 read-write 스토리지까지 넓힌다.
  // 세부 목록이 구현마다 앞서거니 뒤서거니 하는 구간이라, 여기서는
  // 스토리지 방향의 "관대함"을 불일치로 보지 않는 선에서 멈춘다.
  if (features.has('texture-formats-tier2') && meta.kind === 'color') {
    e.storage = e.storage || TIER1_STORAGE.has(meta.format);
  }

  return e;
}

/**
 * 실측이 기준선보다 관대할 때 그걸 불일치로 볼지.
 * tier feature 가 켜져 있으면 확장 목록이 구현마다 달라서 노이즈가 된다.
 */
export function toleratesExtraStorage(features: Set<string>): boolean {
  return features.has('texture-formats-tier1') || features.has('texture-formats-tier2');
}

/** bindGroupLayout 에 넣을 sampleType */
export function sampleTypeOf(meta: FormatMeta): GPUTextureSampleType {
  if (meta.kind === 'depth') {
    // stencil 만 있는 포맷은 uint 로 읽는다
    return meta.hasDepth ? 'depth' : 'uint';
  }
  if (meta.texel === 'u32') return 'uint';
  if (meta.texel === 'i32') return 'sint';
  return meta.filterable ? 'float' : 'unfilterable-float';
}

/** WGSL 텍스처 선언 타입 */
export function wgslTextureType(meta: FormatMeta): string {
  if (meta.kind === 'depth' && meta.hasDepth) return 'texture_depth_2d';
  return `texture_2d<${meta.texel}>`;
}
