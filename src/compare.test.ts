import { describe, it, expect } from 'vitest';
import { compareProfiles } from './compare.js';
import { SCHEMA_VERSION } from './types.js';
import type { AtlasProfile, BenchResult, FormatSupport } from './types.js';

// ── Fixtures ────────────────────────────────────────────
//
// Built by hand rather than captured, so each test states exactly the one
// difference it is about.

function bench(over: Partial<BenchResult> & { id: string }): BenchResult {
  return {
    description: over.id,
    medianMs: 10,
    minMs: 10,
    variation: 0.02,
    timing: 'timestamp-query',
    samples: 7,
    repetitions: 8,
    throughput: 1000,
    throughputUnit: 'MPixel/s',
    ...over,
  };
}

function format(over: Partial<FormatSupport> & { format: string }): FormatSupport {
  return {
    featureDeclared: true,
    creatable: true,
    sampleable: true,
    renderable: true,
    blendable: true,
    storageWritable: true,
    multisample4x: true,
    errors: [],
    ...over,
  };
}

interface ProfileOptions {
  fingerprint: string;
  vendor?: string;
  features?: string[];
  limits?: Record<string, number>;
  formats?: FormatSupport[];
  benchmarks?: BenchResult[];
  schema?: number;
  mobile?: boolean;
  unavailable?: string;
}

function profile(o: ProfileOptions): AtlasProfile {
  const limits = o.limits ?? {};
  return {
    schema: o.schema ?? SCHEMA_VERSION,
    capturedAt: '2026-08-28T00:00:00.000Z',
    fingerprint: o.fingerprint,
    environment: {
      browser: 'Chrome',
      browserVersion: '151.0.0.0',
      mobile: o.mobile ?? false,
      devicePixelRatio: 1,
    },
    adapter: {
      vendor: o.vendor ?? 'nvidia',
      architecture: 'test-arch',
      device: '',
      description: '',
      isFallbackAdapter: false,
      powerPreference: 'default',
    },
    declared: {
      features: o.features ?? [],
      limits,
      preferredCanvasFormat: 'bgra8unorm',
    },
    verified: {
      formats: o.formats ?? [],
      shaders: [],
      limits: Object.entries(limits).map(([limit, v]) => ({
        limit, declared: v, achieved: v, honored: true,
      })),
      deviceLost: false,
    },
    benchmarks: o.benchmarks
      ? {
        results: o.benchmarks,
        timestampQuery: true,
        timerResolutionNs: 65536,
        wallClockResolutionMs: 0.1,
        totalMs: 1000,
      }
      : null,
    discrepancies: [],
    elapsedMs: 2000,
    ...(o.unavailable ? { unavailable: o.unavailable } : {}),
  };
}

// ── Tests ───────────────────────────────────────────────

describe('compareProfiles: features', () => {
  it('separates shared features from uneven ones', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', features: ['timestamp-query', 'shader-f16'] }),
      profile({ fingerprint: 'bbb', features: ['timestamp-query', 'subgroups'] }),
    ]);

    expect(c.sharedFeatures).toEqual(['timestamp-query']);
    expect(c.features.map((f) => f.feature).sort()).toEqual(['shader-f16', 'subgroups']);

    const f16 = c.features.find((f) => f.feature === 'shader-f16')!;
    expect(f16.supportedBy).toEqual(['aaa']);
    expect(f16.missingFrom).toEqual(['bbb']);
  });

  it('reports nothing uneven when features match', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', features: ['timestamp-query'] }),
      profile({ fingerprint: 'bbb', features: ['timestamp-query'] }),
    ]);
    expect(c.features).toEqual([]);
    expect(c.sharedFeatures).toEqual(['timestamp-query']);
  });
});

describe('compareProfiles: formats', () => {
  it('reports only capabilities that actually differ', () => {
    const c = compareProfiles([
      profile({
        fingerprint: 'aaa',
        formats: [
          format({ format: 'rgba8unorm' }),
          format({ format: 'bgra8unorm', storageWritable: true }),
        ],
      }),
      profile({
        fingerprint: 'bbb',
        formats: [
          format({ format: 'rgba8unorm' }),
          format({ format: 'bgra8unorm', storageWritable: false }),
        ],
      }),
    ]);

    expect(c.formats).toHaveLength(1);
    expect(c.formats[0]).toMatchObject({
      format: 'bgra8unorm',
      capability: 'storageWritable',
      supportedBy: ['aaa'],
      missingFrom: ['bbb'],
    });
  });

  it('ignores a format one profile never checked', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', formats: [format({ format: 'bc7-rgba-unorm' })] }),
      profile({ fingerprint: 'bbb', formats: [] }),
    ]);
    // Absence of a check is not evidence the format is unsupported.
    expect(c.formats).toEqual([]);
  });
});

describe('compareProfiles: limits', () => {
  it('reports differing limits widest gap first', () => {
    const c = compareProfiles([
      profile({
        fingerprint: 'aaa',
        limits: { maxUniformBufferBindingSize: 65536, maxBufferSize: 2_000_000_000 },
      }),
      profile({
        fingerprint: 'bbb',
        limits: { maxUniformBufferBindingSize: 715_827_880, maxBufferSize: 1_000_000_000 },
      }),
    ]);

    expect(c.limits.map((l) => l.limit)).toEqual([
      'maxUniformBufferBindingSize',
      'maxBufferSize',
    ]);
    expect(c.limits[0].ratio).toBeCloseTo(715_827_880 / 65536, 1);
    expect(c.limits[1].ratio).toBeCloseTo(2, 5);
  });

  it('omits limits that match', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', limits: { maxBufferSize: 1000 } }),
      profile({ fingerprint: 'bbb', limits: { maxBufferSize: 1000 } }),
    ]);
    expect(c.limits).toEqual([]);
  });
});

describe('compareProfiles: benchmarks', () => {
  it('sorts by spread and computes the ratio', () => {
    const c = compareProfiles([
      profile({
        fingerprint: 'aaa',
        benchmarks: [
          bench({ id: 'narrow', throughput: 100 }),
          bench({ id: 'wide', throughput: 6000 }),
        ],
      }),
      profile({
        fingerprint: 'bbb',
        benchmarks: [
          bench({ id: 'narrow', throughput: 50 }),
          bench({ id: 'wide', throughput: 100 }),
        ],
      }),
    ]);

    expect(c.benchmarks.map((b) => b.id)).toEqual(['wide', 'narrow']);
    expect(c.benchmarks[0].ratio).toBeCloseTo(60, 5);
    expect(c.benchmarks[0].fastest).toBe('aaa');
    expect(c.benchmarks[0].slowest).toBe('bbb');
  });

  it('flags a quantized measurement as unreliable', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', benchmarks: [bench({ id: 'x', quantized: true })] }),
      profile({ fingerprint: 'bbb', benchmarks: [bench({ id: 'x', throughput: 500 })] }),
    ]);
    expect(c.benchmarks[0].unreliable).toEqual(['aaa']);
  });

  it('flags an unstable measurement as unreliable', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', benchmarks: [bench({ id: 'x', variation: 0.4 })] }),
      profile({ fingerprint: 'bbb', benchmarks: [bench({ id: 'x', throughput: 500 })] }),
    ]);
    expect(c.benchmarks[0].unreliable).toEqual(['aaa']);
  });

  it('records a null value for a benchmark that failed', () => {
    const c = compareProfiles([
      profile({
        fingerprint: 'aaa',
        benchmarks: [bench({ id: 'x', failed: 'setup failed', throughput: undefined })],
      }),
      profile({ fingerprint: 'bbb', benchmarks: [bench({ id: 'x', throughput: 500 })] }),
    ]);
    expect(c.benchmarks[0].values.aaa).toBeNull();
    expect(c.benchmarks[0].ratio).toBeNull();
  });
});

describe('compareProfiles: older schemas', () => {
  it('marks pre-v2 benchmarks stale and unreliable', () => {
    // A version 1 profile carries no quantization data, so its silence about
    // reliability means "not recorded" rather than "fine".
    const c = compareProfiles([
      profile({ fingerprint: 'old', schema: 1, benchmarks: [bench({ id: 'x' })] }),
      profile({ fingerprint: 'new', benchmarks: [bench({ id: 'x', throughput: 500 })] }),
    ]);

    const old = c.devices.find((d) => d.fingerprint === 'old')!;
    expect(old.schema).toBe(1);
    expect(old.staleBenchmarks).toBe(true);

    const fresh = c.devices.find((d) => d.fingerprint === 'new')!;
    expect(fresh.staleBenchmarks).toBe(false);

    expect(c.benchmarks[0].unreliable).toEqual(['old']);
    // The value is still reported — flagged, not discarded.
    expect(c.benchmarks[0].values.old).toBe(1000);
  });

  it('still compares capabilities from an older profile', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'old', schema: 1, features: ['shader-f16'] }),
      profile({ fingerprint: 'new', features: [] }),
    ]);
    // Capability data did not change shape, so it remains comparable.
    expect(c.features.map((f) => f.feature)).toEqual(['shader-f16']);
  });
});

describe('compareProfiles: unusable profiles', () => {
  it('excludes a profile where WebGPU was unavailable', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'ok' }),
      profile({ fingerprint: 'nope', unavailable: 'navigator.gpu is missing' }),
    ]);

    expect(c.devices.map((d) => d.fingerprint)).toEqual(['ok']);
    expect(c.excluded).toHaveLength(1);
    expect(c.excluded[0].index).toBe(1);
    expect(c.excluded[0].reason).toContain('navigator.gpu is missing');
  });

  it('labels devices readably', () => {
    const c = compareProfiles([
      profile({ fingerprint: 'aaa', vendor: 'apple', mobile: true }),
      profile({ fingerprint: 'bbb' }),
    ]);
    expect(c.devices[0].label).toBe('apple test-arch / Chrome 151');
    expect(c.devices[0].mobile).toBe(true);
  });
});
