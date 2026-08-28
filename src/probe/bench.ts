// Rendering microbenchmarks.
//
// The goal is not a single score but knowing which axis a device falls apart on.
// A device that is cheap on draw calls but weak on fill rate needs the opposite
// optimization from one that is the reverse, and a composite score erases that.
//
// Two things matter most for these numbers to mean anything:
//
// 1. Timestamp quantization. Browsers round timestamp-query results into coarse
//    buckets as a Spectre mitigation — tens to hundreds of microseconds. Work
//    shorter than one bucket collapses to the same value, so unrelated
//    benchmarks report identical numbers.
// 2. Draw call and state change cost lives in browser validation and driver
//    calls, which barely register on GPU timestamps. That family is wall-clock.
// 3. Repeated overdraw is not a reliable way to create fragment work. A
//    tile-based deferred GPU (Apple silicon, PowerVR) discards occluded opaque
//    draws before shading them, so stacking identical fullscreen passes
//    measures almost nothing there while measuring the full cost elsewhere —
//    the same benchmark ends up meaning different things per architecture.
//    Additive blending makes every draw contribute to the result, which
//    removes the option of discarding it.
//
// So each benchmark defines only a unit of work, and the repetition count is
// raised automatically until the measurement clears the quantization bucket.
//
// The bucket size is measured rather than assumed: timing a pass that does
// almost no GPU work reports the quantization floor directly. Every result then
// records how many resolution units it spans, which is the only way to tell a
// genuinely stable measurement from one flattened onto that floor — both show a
// variation of zero.

import type { BenchResult, BenchmarkResults } from '../types.js';
import { GpuTimer, median, variation } from './timer.js';
import { dispose } from './errors.js';
import { estimateBucket } from './quantization.js';

const TARGET = 1024;
const WARMUP = 3;

/** Scale repetitions until measurements exceed this, to clear quantization */
const TARGET_MS = 10;
/** ...and until they span at least this many timer resolution units */
const MIN_TICKS = 100;
/**
 * Wall-clock ticks required. Lower than MIN_TICKS because performance.now() is
 * coarse enough on some browsers (1ms in Safari) that demanding 100 would make
 * every draw-call benchmark take several seconds.
 */
const MIN_WALL_TICKS = 60;
/** Below this many ticks a measurement is reported as quantized */
const QUANTIZED_BELOW_TICKS = 20;
/** Cap on the repetition multiplier, so slow devices still finish */
const MAX_REPS = 2048;

interface BenchCtx {
  /** Record `reps` times the unit workload */
  record(encoder: GPUCommandEncoder, reps: number, writes?: GPURenderPassTimestampWrites): void;
  dispose?(): void;
}

interface BenchSpec {
  id: string;
  description: string;
  /** Workload at reps = 1 */
  unitWorkload: number;
  unit: string;
  /** Draw call family is meaningless when measured as GPU time */
  timingMode: 'gpu-preferred' | 'wall-clock-only';
  setup(device: GPUDevice, view: GPUTextureView): Promise<BenchCtx>;
}

const FULLSCREEN_VS = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}`;

// Sending every vertex to the same position degenerates the triangle, leaving
// draw call cost without any rasterization.
const DEGENERATE_VS = `
@vertex fn vs() -> @builtin(position) vec4f {
  return vec4f(2., 2., 0.5, 1.);
}`;

const SOLID_FS = `
@fragment fn fs() -> @location(0) vec4f { return vec4f(0.25, 0.5, 0.75, 1.); }`;

/**
 * Additive blending, used by every overdraw-based benchmark.
 *
 * Without it a deferred renderer is free to drop all but the last draw, since
 * an opaque fragment fully replaces what is under it. Accumulating means each
 * draw changes the result and none of them can be skipped.
 */
const ACCUMULATE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Every benchmark renders into the same target format */
const TARGET_FORMAT: GPUTextureFormat = 'rgba8unorm';

/**
 * Build the render pipeline a benchmark needs.
 *
 * Takes WGSL source, or an already-created module for the cases that build
 * several pipelines from one shader shape.
 */
function renderPipeline(
  device: GPUDevice,
  codeOrModule: string | GPUShaderModule,
  blend?: GPUBlendState,
): Promise<GPURenderPipeline> {
  const module = typeof codeOrModule === 'string'
    ? device.createShaderModule({ code: codeOrModule })
    : codeOrModule;

  return device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: {
      module,
      entryPoint: 'fs',
      targets: [blend ? { format: TARGET_FORMAT, blend } : { format: TARGET_FORMAT }],
    },
  });
}

const DRAWS_PER_REP = 2_000;
const TRIS_PER_REP = 100_000;

const SPECS: BenchSpec[] = [
  {
    id: 'drawcall-overhead',
    description: 'Empty draw calls — browser validation and driver call cost',
    unitWorkload: DRAWS_PER_REP,
    unit: 'draws/s',
    timingMode: 'wall-clock-only',
    setup: async (device, view) => {
      const pipeline = await renderPipeline(device, DEGENERATE_VS + SOLID_FS);
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          const n = DRAWS_PER_REP * reps;
          for (let i = 0; i < n; i++) pass.draw(3);
          pass.end();
        },
      };
    },
  },
  {
    id: 'pipeline-switch',
    description: 'Alternating between 8 pipelines per draw — state change cost',
    unitWorkload: DRAWS_PER_REP,
    unit: 'switches/s',
    timingMode: 'wall-clock-only',
    setup: async (device, view) => {
      const pipelines: GPURenderPipeline[] = [];
      for (let i = 0; i < 8; i++) {
        // Vary the shader slightly so these really are distinct pipelines.
        pipelines.push(await renderPipeline(device, DEGENERATE_VS + `
@fragment fn fs() -> @location(0) vec4f { return vec4f(${(i / 8).toFixed(3)}, 0.5, 0.75, 1.); }`));
      }
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          const n = DRAWS_PER_REP * reps;
          for (let i = 0; i < n; i++) {
            pass.setPipeline(pipelines[i & 7]);
            pass.draw(3);
          }
          pass.end();
        },
      };
    },
  },
  {
    id: 'bindgroup-switch',
    description: 'Alternating between 64 bind groups per draw — resource binding cost',
    unitWorkload: DRAWS_PER_REP,
    unit: 'binds/s',
    timingMode: 'wall-clock-only',
    setup: async (device, view) => {
      const pipeline = await renderPipeline(device, `
struct U { tint: vec4f };
@group(0) @binding(0) var<uniform> u: U;
${DEGENERATE_VS}
@fragment fn fs() -> @location(0) vec4f { return u.tint; }`);
      const layout = pipeline.getBindGroupLayout(0);
      const buffers: GPUBuffer[] = [];
      const groups: GPUBindGroup[] = [];
      for (let i = 0; i < 64; i++) {
        const buf = device.createBuffer({
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(buf, 0, new Float32Array([i / 64, 0.5, 0.75, 1]));
        buffers.push(buf);
        groups.push(device.createBindGroup({
          layout,
          entries: [{ binding: 0, resource: { buffer: buf } }],
        }));
      }
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          const n = DRAWS_PER_REP * reps;
          for (let i = 0; i < n; i++) {
            pass.setBindGroup(0, groups[i & 63]);
            pass.draw(3);
          }
          pass.end();
        },
        dispose: () => dispose(...buffers),
      };
    },
  },
  {
    id: 'fillrate',
    description: `${TARGET}x${TARGET} fullscreen overdraw, blended — fragment throughput`,
    unitWorkload: TARGET * TARGET * 8,
    unit: 'MPixel/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const pipeline = await renderPipeline(device, FULLSCREEN_VS + SOLID_FS, ACCUMULATE);
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          const n = 8 * reps;
          for (let i = 0; i < n; i++) pass.draw(3);
          pass.end();
        },
      };
    },
  },
  {
    id: 'fragment-alu',
    description: 'Heavy per-pixel arithmetic — shader math, separated from fill rate',
    unitWorkload: TARGET * TARGET,
    unit: 'MPixel/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const module = device.createShaderModule({
        code: FULLSCREEN_VS + `
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var p = pos.xyz * 0.001;
  var acc = 0.;
  for (var i = 0u; i < 64u; i++) {
    p = fract(p * 1.7 + vec3f(0.31, 0.17, 0.53));
    acc += dot(p, vec3f(0.33)) * exp(-p.x) + sqrt(abs(p.y));
  }
  return vec4f(acc * 0.01, p.y, p.z, 1.);
}`,
      });
      const pipeline = await renderPipeline(device, module, ACCUMULATE);
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          for (let i = 0; i < reps; i++) pass.draw(3);
          pass.end();
        },
      };
    },
  },
  {
    id: 'triangle-throughput',
    description: 'Many small triangles — geometry throughput',
    unitWorkload: TRIS_PER_REP,
    unit: 'MTri/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const module = device.createShaderModule({
        code: `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let tri = vi / 3u;
  let corner = vi % 3u;
  // Scatter triangles across a grid — they must stay on screen to avoid culling.
  let gx = f32(tri % 1000u) / 1000. * 2. - 1.;
  let gy = f32((tri / 1000u) % 100u) / 100. * 2. - 1.;
  var off = array<vec2f, 3>(vec2f(0., 0.), vec2f(0.0015, 0.), vec2f(0., 0.0015));
  return vec4f(gx + off[corner].x, gy + off[corner].y, 0.5, 1.);
}
${SOLID_FS}`,
      });
      const pipeline = await renderPipeline(device, module);
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          // Each draw is heavy enough that draw call overhead is buried.
          for (let i = 0; i < reps; i++) pass.draw(TRIS_PER_REP * 3);
          pass.end();
        },
      };
    },
  },
  {
    id: 'texture-sampling',
    description: '32 texture samples per pixel — texture bandwidth',
    unitWorkload: TARGET * TARGET * 32,
    unit: 'GSample/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const tex = device.createTexture({
        size: [512, 512],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const pixels = new Uint8Array(512 * 512 * 4);
      for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 0xff;
      device.queue.writeTexture({ texture: tex }, pixels, { bytesPerRow: 512 * 4 }, [512, 512]);

      const module = device.createShaderModule({
        code: `
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
${FULLSCREEN_VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var acc = vec4f(0.);
  let base = pos.xy / ${TARGET}.;
  for (var i = 0u; i < 32u; i++) {
    // Spread the coordinates so this does not all sit in cache.
    let uv = fract(base + vec2f(f32(i) * 0.137, f32(i) * 0.379));
    acc += textureSampleLevel(t, s, uv, 0.);
  }
  return acc * 0.03125;
}`,
      });
      const pipeline = await renderPipeline(device, module, ACCUMULATE);
      const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: sampler },
        ],
      });
      return {
        record(encoder, reps, writes) {
          const pass = beginPass(encoder, view, writes);
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          for (let i = 0; i < reps; i++) pass.draw(3);
          pass.end();
        },
        dispose: () => dispose(tex),
      };
    },
  },
];

/**
 * Measure performance.now()'s granularity by spinning until it changes.
 *
 * Browsers round this too — Safari to a full millisecond — which matters
 * because the draw-call benchmarks are wall-clock by design. A 10ms reading
 * against a 1ms clock carries barely more than one significant digit, and it
 * showed up as those benchmarks swinging ~70% between runs.
 */
function wallClockResolutionMs(): number {
  let smallest = Infinity;
  for (let i = 0; i < 24; i++) {
    const start = performance.now();
    let next = start;
    // Spin until the clock advances; the jump is one tick.
    while (next === start) next = performance.now();
    smallest = Math.min(smallest, next - start);
  }
  return Number.isFinite(smallest) && smallest > 0 ? smallest : 0;
}

/**
 * Measure the GPU timer's granularity.
 *
 * Work shorter than one bucket reports as zero, so the approach is to grow a
 * trivial workload until readings first become non-zero. The smallest positive
 * reading bounds the bucket from above, and the smallest gap between distinct
 * readings usually lands on the bucket itself — quantized values are all
 * multiples of it. The tighter of the two is used.
 *
 * Returns null when the timer appears continuous (no quantization detected) or
 * when readings could not be obtained at all.
 */
async function calibrateResolution(
  device: GPUDevice,
  timer: GpuTimer,
): Promise<number | null> {
  if (!timer.available) return null;

  const tex = device.createTexture({
    size: [256, 256],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const view = tex.createView();

  let pipeline: GPURenderPipeline;
  try {
    pipeline = await renderPipeline(device, FULLSCREEN_VS + SOLID_FS);
  } catch {
    dispose(tex);
    return null;
  }

  const readings: number[] = [];

  // Grow the workload until readings stop collapsing to zero.
  let draws = 1;
  for (let attempt = 0; attempt < 14; attempt++) {
    let positives = 0;

    for (let i = 0; i < 6; i++) {
      const enc = device.createCommandEncoder();
      const writes = timer.writes();
      const pass = beginPass(enc, view, writes);
      pass.setPipeline(pipeline);
      for (let d = 0; d < draws; d++) pass.draw(3);
      pass.end();
      if (writes) timer.resolve(enc);
      device.queue.submit([enc.finish()]);
      await device.queue.onSubmittedWorkDone();

      const ns = await timer.read();
      if (ns === null) continue;
      readings.push(ns);
      if (ns > 0) positives++;
    }

    // Enough non-zero readings to work with, and a few distinct values to
    // measure gaps between.
    if (positives >= 4 && new Set(readings.filter((v) => v > 0)).size >= 2) break;
    draws *= 4;
  }

  dispose(tex);

  // The estimate has to survive being checked against the readings before it is
  // reported. See quantization.ts — a single number cannot tell a bucket apart
  // from the cost of a short workload, and conflating them made the same
  // machine report a different timer on consecutive runs.
  return estimateBucket(readings);
}

export async function runBenchmarks(
  device: GPUDevice,
  samples: number,
  onProgress?: (ratio: number) => void,
): Promise<BenchmarkResults> {
  const started = performance.now();
  const timer = GpuTimer.create(device);

  const target = device.createTexture({
    size: [TARGET, TARGET],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const view = target.createView();

  const resolutionNs = await calibrateResolution(device, timer);
  const wallResolutionMs = wallClockResolutionMs();

  const results: BenchResult[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    results.push(await measure(
      device, SPECS[i], view, timer, samples, resolutionNs, wallResolutionMs,
    ));
    onProgress?.((i + 1) / SPECS.length);
  }

  timer.dispose();
  dispose(target);

  return {
    results,
    timestampQuery: timer.available,
    timerResolutionNs: resolutionNs,
    wallClockResolutionMs: wallResolutionMs > 0 ? wallResolutionMs : null,
    totalMs: Math.round(performance.now() - started),
  };
}

async function measure(
  device: GPUDevice,
  spec: BenchSpec,
  view: GPUTextureView,
  timer: GpuTimer,
  samples: number,
  resolutionNs: number | null,
  wallResolutionMs: number,
): Promise<BenchResult> {
  const base: BenchResult = {
    id: spec.id,
    description: spec.description,
    medianMs: 0,
    minMs: 0,
    variation: 0,
    timing: 'wall-clock',
    samples: 0,
    repetitions: 0,
  };

  let ctx: BenchCtx;
  try {
    ctx = await spec.setup(device, view);
  } catch (e) {
    return { ...base, failed: `setup failed: ${describe(e)}` };
  }

  const useGpuTime = spec.timingMode === 'gpu-preferred' && timer.available;

  try {
    // Warm up — the first run mixes in shader translation and resource setup.
    for (let i = 0; i < WARMUP; i++) {
      const enc = device.createCommandEncoder();
      ctx.record(enc, 1);
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();

    // Auto-scale the repetition count. A measurement has to clear both a fixed
    // floor and a multiple of the timer resolution, because a coarse timer can
    // still flatten a 10ms measurement on some devices.
    // Each clock has its own floor. A GPU-timed benchmark is not bounded by
    // performance.now()'s granularity, and treating it as if it were just makes
    // the run longer for nothing.
    const targetMs = useGpuTime
      ? (resolutionNs
        ? Math.max(TARGET_MS, (resolutionNs * MIN_TICKS) / 1e6)
        // A continuous GPU timer imposes no floor of its own.
        : TARGET_MS)
      : Math.max(TARGET_MS, wallResolutionMs * MIN_WALL_TICKS);

    let reps = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { ms } = await once(device, ctx, reps, timer, useGpuTime);
      if (ms >= targetMs || reps >= MAX_REPS) break;
      // Estimate the multiplier needed, but do not jump too far at once.
      const factor = ms > 0.001 ? Math.ceil(targetMs / ms) : 8;
      reps = Math.min(MAX_REPS, reps * Math.max(2, Math.min(16, factor)));
    }

    const times: number[] = [];
    let gpuTimed = 0;
    for (let i = 0; i < samples; i++) {
      const { ms, fromGpu } = await once(device, ctx, reps, timer, useGpuTime);
      times.push(ms);
      if (fromGpu) gpuTimed++;
    }

    ctx.dispose?.();

    if (times.length === 0) {
      return { ...base, failed: 'no measurements were obtained' };
    }

    const fromGpuTimer = gpuTimed > times.length / 2;

    // Wall-clock samples carry scheduler noise the GPU timer does not, and it is
    // one-sided: an interrupted sample is slow, never fast. Dropping the
    // extremes keeps a single hiccup from moving the reported figure.
    const usable = fromGpuTimer ? times : trimExtremes(times);

    const med = median(usable);
    const workload = spec.unitWorkload * reps;
    const result: BenchResult = {
      ...base,
      medianMs: round(med, 4),
      minMs: round(Math.min(...usable), 4),
      variation: round(variation(usable), 3),
      timing: fromGpuTimer ? 'timestamp-query' : 'wall-clock',
      samples: usable.length,
      repetitions: reps,
    };

    // Both clocks quantize; which one applies depends on how this was timed.
    const tickSizeMs = fromGpuTimer
      ? (resolutionNs != null ? resolutionNs / 1e6 : null)
      : (wallResolutionMs > 0 ? wallResolutionMs : null);

    if (tickSizeMs) {
      const ticks = med / tickSizeMs;
      result.ticks = round(ticks, 1);
      result.quantized = ticks < QUANTIZED_BELOW_TICKS;
    }

    if (med > 0) {
      const perSecond = workload / (med / 1000);
      result.throughput = round(scaleTo(perSecond, spec.unit), 2);
      result.throughputUnit = spec.unit;
    }

    return result;
  } catch (e) {
    ctx.dispose?.();
    return { ...base, failed: `run failed: ${describe(e)}` };
  }
}

/** Run once, returning elapsed ms and whether that came from GPU timestamps */
async function once(
  device: GPUDevice,
  ctx: BenchCtx,
  reps: number,
  timer: GpuTimer,
  useGpuTime: boolean,
): Promise<{ ms: number; fromGpu: boolean }> {
  const enc = device.createCommandEncoder();
  const writes = useGpuTime ? timer.writes() : undefined;
  const t0 = performance.now();
  ctx.record(enc, reps, writes);
  if (writes) timer.resolve(enc);
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const wall = performance.now() - t0;

  if (writes) {
    const gpuNs = await timer.read();
    // Zero means the work fit inside one bucket — no usable duration.
    if (gpuNs !== null && gpuNs > 0) return { ms: gpuNs / 1e6, fromGpu: true };
  }
  return { ms: wall, fromGpu: false };
}

/** Drop the highest and lowest sample, when there are enough to spare them */
function trimExtremes(values: number[]): number[] {
  if (values.length < 5) return values;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.slice(1, -1);
}

function beginPass(
  encoder: GPUCommandEncoder,
  view: GPUTextureView,
  writes?: GPURenderPassTimestampWrites,
): GPURenderPassEncoder {
  const desc: GPURenderPassDescriptor = {
    colorAttachments: [{
      view,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  };
  if (writes) desc.timestampWrites = writes;
  return encoder.beginRenderPass(desc);
}

function scaleTo(perSecond: number, unit: string): number {
  if (unit.startsWith('M')) return perSecond / 1e6;
  if (unit.startsWith('G')) return perSecond / 1e9;
  return perSecond;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
