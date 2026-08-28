import { describe, it, expect } from 'vitest';
import { analyze } from './discrepancies.js';
import type {
  BenchmarkResults, BenchResult, FormatSupport, LimitProbe, ProbeError, ShaderCase,
} from '../types.js';

function fmt(over: Partial<FormatSupport> & { format: string }): FormatSupport {
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

const err = (message: string): ProbeError => ({ kind: 'validation', message });

function shader(over: Partial<ShaderCase> & { id: string }): ShaderCase {
  return {
    description: over.id,
    skipped: false,
    compiled: true,
    pipelineCreated: true,
    messages: [],
    compileMs: 1,
    ...over,
  };
}

function limit(over: Partial<LimitProbe> & { limit: string }): LimitProbe {
  return { declared: 100, achieved: 100, honored: true, ...over };
}

function benches(results: Partial<BenchResult>[]): BenchmarkResults {
  return {
    results: results.map((r, i) => ({
      id: `b${i}`,
      description: '',
      medianMs: 10,
      minMs: 10,
      variation: 0.02,
      timing: 'timestamp-query',
      samples: 7,
      repetitions: 8,
      ...r,
    })),
    timestampQuery: true,
    timerResolutionNs: 65536,
    wallClockResolutionMs: 0.1,
    totalMs: 100,
  };
}

const noFeatures = new Set<string>();

describe('analyze: formats', () => {
  it('reports a declared feature whose format cannot be created', () => {
    const d = analyze(
      [fmt({
        format: 'bc7-rgba-unorm',
        requiresFeature: 'texture-compression-bc',
        featureDeclared: true,
        creatable: false,
        errors: [err('unsupported')],
      })],
      [], [], null, new Set(['texture-compression-bc']),
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      kind: 'format-declared-not-usable',
      subject: 'bc7-rgba-unorm',
      severity: 'breaking',
    });
    expect(d[0].detail).toContain('unsupported');
  });

  it('reports a format that creates but cannot be sampled', () => {
    // The nastier failure: it looks like it worked.
    const d = analyze(
      [fmt({ format: 'depth24plus-stencil8', sampleable: false, errors: [err('aspect')] })],
      [], [], null, noFeatures,
    );
    expect(d.some((x) => x.severity === 'breaking' && x.detail.includes('sampling'))).toBe(true);
  });

  it('says nothing when a format behaves as the spec says', () => {
    const d = analyze([fmt({ format: 'rgba8unorm' })], [], [], null, noFeatures);
    expect(d).toEqual([]);
  });

  it('does not flag tier1 storage support as more permissive than spec', () => {
    // r8unorm is not a core storage format, but texture-formats-tier1 adds it.
    // Comparing against the core baseline produced 18 false reports.
    const withTier = analyze(
      [fmt({ format: 'r8unorm', storageWritable: true })],
      [], [], null, new Set(['texture-formats-tier1']),
    );
    expect(withTier).toEqual([]);
  });

  it('flags storage support that no declared feature explains', () => {
    const d = analyze(
      [fmt({ format: 'rgba8unorm-srgb', storageWritable: true })],
      [], [], null, noFeatures,
    );
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: 'format-usable-not-declared', severity: 'note' });
  });

  it('flags a spec-renderable format that fails to render', () => {
    const d = analyze(
      [fmt({ format: 'rgba8unorm', renderable: false, errors: [err('render pass failed')] })],
      [], [], null, noFeatures,
    );
    expect(d.some((x) => x.severity === 'breaking' && x.detail.includes('render target'))).toBe(true);
  });
});

describe('analyze: limits', () => {
  it('calls a limit under half its declared value breaking', () => {
    const d = analyze([], [], [
      limit({ limit: 'maxBufferSize', declared: 2000, achieved: 500, honored: false }),
    ], null, noFeatures);
    expect(d[0]).toMatchObject({ kind: 'limit-not-honored', severity: 'breaking' });
  });

  it('calls a smaller shortfall degraded', () => {
    const d = analyze([], [], [
      limit({ limit: 'maxBufferSize', declared: 1000, achieved: 900, honored: false }),
    ], null, noFeatures);
    expect(d[0].severity).toBe('degraded');
  });

  it('ignores an honored limit', () => {
    const d = analyze([], [], [limit({ limit: 'maxBufferSize' })], null, noFeatures);
    expect(d).toEqual([]);
  });
});

describe('analyze: shaders', () => {
  it('reports a compile failure', () => {
    const d = analyze([], [shader({
      id: 'function-pointers',
      compiled: false,
      messages: [{ type: 'error', message: 'unsupported pointer', lineNum: 3 }],
    })], [], null, noFeatures);
    expect(d[0]).toMatchObject({ kind: 'shader-compile-failure', severity: 'breaking' });
  });

  it('separates a pipeline failure from a compile failure', () => {
    // Compiling proves nothing; backend translation happens at pipeline time.
    const d = analyze([], [shader({ id: 'x', compiled: true, pipelineCreated: false })],
      [], null, noFeatures);
    expect(d[0].kind).toBe('shader-pipeline-failure');
  });

  it('ignores a skipped case', () => {
    // Skipping is a fact about the device's features, not a defect. This used
    // to be detected by matching on message text.
    const d = analyze([], [shader({
      id: 'f16-arithmetic', skipped: true, compiled: false, pipelineCreated: false,
    })], [], null, noFeatures);
    expect(d).toEqual([]);
  });
});

describe('analyze: benchmarks', () => {
  it('reports a benchmark that did not finish', () => {
    const d = analyze([], [], [], benches([{ failed: 'setup failed' }]), noFeatures);
    expect(d[0]).toMatchObject({ kind: 'performance-cliff', severity: 'degraded' });
  });

  it('reports a measurement sitting on the quantization floor', () => {
    const d = analyze([], [], [], benches([{ quantized: true, ticks: 3 }]), noFeatures);
    expect(d[0].kind).toBe('performance-cliff');
    expect(d[0].detail).toContain('quantization floor');
  });

  it('prefers the quantization explanation over instability', () => {
    // A quantized reading is often perfectly stable, so reporting it as noise
    // would point at the wrong cause.
    const d = analyze([], [], [], benches([{ quantized: true, ticks: 2, variation: 0.5 }]),
      noFeatures);
    expect(d).toHaveLength(1);
    expect(d[0].detail).toContain('quantization floor');
  });

  it('reports an unstable measurement', () => {
    const d = analyze([], [], [], benches([{ variation: 0.5 }]), noFeatures);
    expect(d[0].detail).toContain('throttling');
  });

  it('says nothing about a sound measurement', () => {
    const d = analyze([], [], [], benches([{ variation: 0.02, ticks: 180 }]), noFeatures);
    expect(d).toEqual([]);
  });
});
