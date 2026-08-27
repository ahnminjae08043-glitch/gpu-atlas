// 렌더링 마이크로벤치.
//
// 목적은 "이 GPU 가 몇 점이다" 같은 종합점수가 아니라, 어느 축에서 무너지는지를
// 분리해서 보는 것이다. 드로우콜이 싼데 필레이트가 낮은 기기와 그 반대인 기기는
// 완전히 다른 최적화를 요구하는데, 종합점수는 그걸 뭉개버린다.
//
// 측정에서 가장 조심할 두 가지:
//
// 1. 타임스탬프 양자화. 브라우저는 스펙터 완화 때문에 timestamp-query 결과를
//    수십~수백 마이크로초 단위로 반올림한다. 그보다 짧게 끝나는 작업은 전부
//    같은 값으로 뭉개져서, 서로 다른 벤치가 똑같은 수치를 뱉는다.
// 2. 드로우콜/상태전환 비용의 본질은 브라우저 검증과 드라이버 호출이라
//    GPU 타임스탬프에는 거의 잡히지 않는다. 이 계열은 벽시계로 잰다.
//
// 그래서 각 벤치는 "단위 작업"만 정의하고, 실제 반복 횟수는 측정 시간이
// 양자화 단위를 충분히 넘을 때까지 자동으로 올린다.

import type { BenchResult, BenchmarkResults } from '../types.js';
import { GpuTimer, median, variation } from './timer.js';
import { dispose } from './errors.js';

const TARGET = 1024;
const WARMUP = 3;

/** 이 시간을 넘도록 반복 횟수를 올린다. 양자화 단위의 수십 배를 확보하는 것이 목적 */
const TARGET_MS = 10;
/** 반복 배수 상한 — 느린 기기에서 벤치가 끝나지 않는 걸 막는다 */
const MAX_REPS = 2048;

interface BenchCtx {
  /** reps 배만큼 단위 작업을 기록한다 */
  record(encoder: GPUCommandEncoder, reps: number, writes?: GPURenderPassTimestampWrites): void;
  dispose?(): void;
}

interface BenchSpec {
  id: string;
  description: string;
  /** reps=1 일 때의 작업량 */
  unitWorkload: number;
  unit: string;
  /** 드로우콜 계열은 GPU 시간으로 재면 의미가 없다 */
  timingMode: 'gpu-preferred' | 'wall-clock-only';
  setup(device: GPUDevice, view: GPUTextureView): Promise<BenchCtx>;
}

const FULLSCREEN_VS = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}`;

// 모든 정점을 같은 위치로 보내 삼각형을 퇴화시킨다. 래스터 비용 없이 드로우콜 비용만 남는다.
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
    description: '빈 드로우콜 — 브라우저 검증과 드라이버 호출 비용',
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
    description: '드로우마다 파이프라인 8개를 번갈아 — 상태 전환 비용',
    unitWorkload: DRAWS_PER_REP,
    unit: 'switches/s',
    timingMode: 'wall-clock-only',
    setup: async (device, view) => {
      const pipelines: GPURenderPipeline[] = [];
      for (let i = 0; i < 8; i++) {
        // 셰이더를 조금씩 다르게 만들어 실제로 다른 파이프라인이 되게 한다.
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
    description: '드로우마다 바인드그룹 64개를 번갈아 — 리소스 바인딩 비용',
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
    description: `${TARGET}x${TARGET} 풀스크린 오버드로우 — 프래그먼트 처리량`,
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
    description: '픽셀당 무거운 산술 — 셰이더 연산 성능 (필레이트와 분리해서 본다)',
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
    description: '작은 삼각형 대량 — 지오메트리 처리량',
    unitWorkload: TRIS_PER_REP,
    unit: 'MTri/s',
    timingMode: 'gpu-preferred',
    setup: async (device, view) => {
      const module = device.createShaderModule({
        code: `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let tri = vi / 3u;
  let corner = vi % 3u;
  // 삼각형을 격자에 흩뿌린다. 화면 안에 있어야 컬링되지 않는다.
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
          // 한 드로우가 충분히 무거워서 드로우콜 오버헤드는 묻힌다.
          for (let i = 0; i < reps; i++) pass.draw(TRIS_PER_REP * 3);
          pass.end();
        },
      };
    },
  },
  {
    id: 'texture-sampling',
    description: '픽셀당 텍스처 샘플 32회 — 텍스처 대역폭',
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
    // 캐시에 다 얹히지 않도록 좌표를 흩는다.
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
  };

  let ctx: BenchCtx;
  try {
    ctx = await spec.setup(device, view);
  } catch (e) {
    return { ...base, failed: `setup 실패: ${describe(e)}` };
  }

  const useGpuTime = spec.timingMode === 'gpu-preferred' && timer.available;

  try {
    // 워밍업 — 첫 실행에는 셰이더 번역과 리소스 준비 비용이 섞인다.
    for (let i = 0; i < WARMUP; i++) {
      const enc = device.createCommandEncoder();
      ctx.record(enc, 1);
      device.queue.submit([enc.finish()]);
    }
    await device.queue.onSubmittedWorkDone();

    // 반복 횟수 자동 조정.
    // 측정값이 TARGET_MS 를 넘어야 타임스탬프 양자화에 뭉개지지 않는다.
    let reps = 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { ms: t } = await once(device, ctx, reps, timer, useGpuTime);
      if (t >= TARGET_MS || reps >= MAX_REPS) break;
      // 목표에 도달할 배수를 추정하되 한 번에 너무 뛰지 않게 제한한다.
      const factor = t > 0.001 ? Math.ceil(TARGET_MS / t) : 8;
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
      return { ...base, failed: '측정값을 하나도 얻지 못했다' };
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
    };

    if (med > 0) {
      const perSecond = workload / (med / 1000);
      result.throughput = round(scaleTo(perSecond, spec.unit), 2);
      result.throughputUnit = spec.unit;
    }

    return result;
  } catch (e) {
    ctx.dispose?.();
    return { ...base, failed: `실행 실패: ${describe(e)}` };
  }
}

/** 한 번 실행하고 소요 시간(ms)과 그게 GPU 시간인지를 돌려준다 */
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
