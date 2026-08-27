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
//
// So each benchmark defines only a unit of work, and the repetition count is
// raised automatically until the measurement clears the quantization bucket.

import type { BenchResult, BenchmarkResults } from '../types.js';
import { GpuTimer, median, variation } from './timer.js';
import { dispose } from './errors.js';

const TARGET = 1024;
const WARMUP = 3;

/** Scale repetitions until measurements exceed this, to clear quantization */
const TARGET_MS = 10;
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
      const module = device.createShaderModule({ code: DEGENERATE_VS + SOLID_FS });
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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
        const module = device.createShaderModule({
          code: DEGENERATE_VS + `
@fragment fn fs() -> @location(0) vec4f { return vec4f(${(i / 8).toFixed(3)}, 0.5, 0.75, 1.); }`,
        });
        pipelines.push(await device.createRenderPipelineAsync({
          layout: 'auto',
          vertex: { module, entryPoint: 'vs' },
          fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        }));
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
      const module = device.createShaderModule({
        code: `
struct U { tint: vec4f };
@group(0) @binding(0) var<uniform> u: U;
${DEGENERATE_VS}
@fragment fn fs() -> @location(0) vec4f { return u.tint; }`,
      });
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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
    description: `${TARGET}x${TARGET} fullscreen overdraw — fragment throughput`,
    unitWorkload: TARGET * TARGET * 8,
    unit: 'MPixel/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const module = device.createShaderModule({ code: FULLSCREEN_VS + SOLID_FS });
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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
      const pipeline = await device.createRenderPipelineAsync({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      });
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

  const results: BenchResult[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    results.push(await measure(device, SPECS[i], view, timer, samples));
    onProgress?.((i + 1) / SPECS.length);
  }

  timer.dispose();
  dispose(target);

  return {
    results,
    timestampQuery: timer.available,
    totalMs: Math.round(performance.now() - started),
  };
}

async function measure(
  device: GPUDevice,
  spec: BenchSpec,
  view: GPUTextureView,
  timer: GpuTimer,
  samples: number,
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

    // Auto-scale the repetition count. Measurements have to exceed TARGET_MS or
    // timestamp quantization flattens them.
    let reps = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { ms } = await once(device, ctx, reps, timer, useGpuTime);
      if (ms >= TARGET_MS || reps >= MAX_REPS) break;
      // Estimate the multiplier needed, but do not jump too far at once.
      const factor = ms > 0.001 ? Math.ceil(TARGET_MS / ms) : 8;
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

    const med = median(times);
    const workload = spec.unitWorkload * reps;
    const result: BenchResult = {
      ...base,
      medianMs: round(med, 4),
      minMs: round(Math.min(...times), 4),
      variation: round(variation(times), 3),
      timing: gpuTimed > times.length / 2 ? 'timestamp-query' : 'wall-clock',
      samples: times.length,
      repetitions: reps,
    };

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
    const gpu = await timer.read();
    if (gpu !== null) return { ms: gpu, fromGpu: true };
  }
  return { ms: wall, fromGpu: false };
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
