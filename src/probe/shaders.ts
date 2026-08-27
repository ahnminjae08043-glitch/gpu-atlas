// WGSL compilation checks.
//
// Every case here is valid WGSL, and implementations still disagree about them.
// Chrome uses Dawn/Tint, Firefox uses wgpu/naga, Safari has its own compiler,
// and each translates to a different backend language (HLSL/MSL/SPIR-V).
// Compile time is measured too — on slow devices it is the main cause of
// first-frame stalls.

import type { ShaderCase, ShaderMessage } from '../types.js';
import { capture } from './errors.js';

interface CaseSpec {
  id: string;
  description: string;
  code: string;
  /** Cases that also need pipeline creation to be attempted */
  pipeline?: 'compute' | 'render';
  /** Skipped when this feature is absent */
  requiresFeature?: string;
}

const VS = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}`;

const CASES: CaseSpec[] = [
  {
    id: 'baseline',
    description: 'The simplest possible render pipeline — a reference point for the rest',
    pipeline: 'render',
    code: `${VS}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.); }`,
  },
  {
    id: 'uniform-dynamic-index',
    description: 'Dynamic indexing into a uniform array — backends add clamping code or slow down',
    pipeline: 'render',
    code: `${VS}
struct Data { items: array<vec4f, 64> };
@group(0) @binding(0) var<uniform> data: Data;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let i = u32(pos.x) % 64u;
  return data.items[i];
}`,
  },
  {
    id: 'nested-loop-break',
    description: 'Nested loops with conditional breaks — where control flow flattening diverges',
    pipeline: 'render',
    code: `${VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var acc = 0.;
  for (var i = 0u; i < 8u; i++) {
    for (var j = 0u; j < 8u; j++) {
      if (f32(i * j) > pos.x) { break; }
      acc += 0.01;
    }
    if (acc > 0.5) { break; }
  }
  return vec4f(acc, 0., 0., 1.);
}`,
  },
  {
    id: 'function-pointers',
    description: 'Passing var<function> pointers — naga and tint handle this differently',
    pipeline: 'render',
    code: `${VS}
fn bump(p: ptr<function, vec3f>, amount: f32) {
  (*p) = (*p) + vec3f(amount);
}
@fragment fn fs() -> @location(0) vec4f {
  var v = vec3f(0.);
  bump(&v, 0.25);
  bump(&v, 0.25);
  return vec4f(v, 1.);
}`,
  },
  {
    id: 'workgroup-atomics',
    description: 'Workgroup memory with atomics and barriers',
    pipeline: 'compute',
    code: `
var<workgroup> counter: atomic<u32>;
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(64) fn cs(@builtin(local_invocation_id) lid: vec3u) {
  if (lid.x == 0u) { atomicStore(&counter, 0u); }
  workgroupBarrier();
  atomicAdd(&counter, 1u);
  workgroupBarrier();
  if (lid.x == 0u) { out[0] = atomicLoad(&counter); }
}`,
  },
  {
    id: 'storage-runtime-array',
    description: 'Runtime-sized array with arrayLength — exercises binding metadata handling',
    pipeline: 'compute',
    code: `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(64) fn cs(@builtin(global_invocation_id) gid: vec3u) {
  let n = arrayLength(&data);
  if (gid.x < n) { data[gid.x] = f32(n); }
}`,
  },
  {
    id: 'struct-alignment',
    description: 'Nested struct alignment and stride — a classic source of backend layout bugs',
    pipeline: 'compute',
    code: `
struct Inner { a: vec3f, b: f32 };
struct Outer { m: mat4x4f, items: array<Inner, 4>, flag: u32 };
@group(0) @binding(0) var<storage, read_write> data: Outer;
@compute @workgroup_size(1) fn cs() {
  data.items[0].b = data.m[0][0] + f32(data.flag);
}`,
  },
  {
    id: 'override-constants',
    description: 'Override constants — pipeline-time specialization, unevenly supported',
    pipeline: 'compute',
    code: `
override tileSize: u32 = 8u;
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(1) fn cs() { out[0] = tileSize; }`,
  },
  {
    id: 'textureSampleLevel-uniform',
    description: 'Texture sampling under non-uniform control flow — uniformity analysis differs',
    pipeline: 'render',
    code: `${VS}
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var c = vec4f(0.);
  if (pos.x > 1.) {
    c = textureSampleLevel(t, s, vec2f(0.5), 0.);
  }
  return c;
}`,
  },
  {
    id: 'long-unrolled',
    description: 'A large shader — exists to measure compile time',
    pipeline: 'render',
    code: `${VS}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var acc = vec3f(0.);
  var p = pos.xyz * 0.01;
${Array.from({ length: 64 }, (_, i) =>
  `  p = fract(p * 1.${(i % 9) + 1} + vec3f(${(i * 0.37).toFixed(3)}));\n` +
  `  acc += p * ${(0.01 + i * 0.001).toFixed(4)};`).join('\n')}
  return vec4f(acc, 1.);
}`,
  },
  {
    id: 'f16-arithmetic',
    description: 'f16 arithmetic via shader-f16 — central to mobile performance, unevenly available',
    requiresFeature: 'shader-f16',
    pipeline: 'render',
    code: `enable f16;
${VS}
@fragment fn fs() -> @location(0) vec4f {
  var v: vec4<f16> = vec4<f16>(0.5h, 0.25h, 0.125h, 1.0h);
  v = v * 2.0h + vec4<f16>(0.1h);
  return vec4f(v);
}`,
  },
];

export async function probeShaders(
  device: GPUDevice,
  declaredFeatures: Set<string>,
  onProgress?: (ratio: number) => void,
): Promise<ShaderCase[]> {
  const out: ShaderCase[] = [];

  for (let i = 0; i < CASES.length; i++) {
    const spec = CASES[i];
    onProgress?.((i + 1) / CASES.length);

    if (spec.requiresFeature && !declaredFeatures.has(spec.requiresFeature)) {
      out.push({
        id: spec.id,
        description: spec.description,
        skipped: true,
        compiled: false,
        pipelineCreated: false,
        messages: [{
          type: 'info',
          message: `skipped: ${spec.requiresFeature} not supported`,
          lineNum: 0,
        }],
        compileMs: 0,
      });
      continue;
    }

    out.push(await runCase(device, spec));
  }

  return out;
}

async function runCase(device: GPUDevice, spec: CaseSpec): Promise<ShaderCase> {
  const result: ShaderCase = {
    id: spec.id,
    description: spec.description,
    skipped: false,
    compiled: false,
    pipelineCreated: false,
    messages: [],
    compileMs: 0,
  };

  const t0 = performance.now();
  const mod = await capture(device, () => device.createShaderModule({ code: spec.code }));

  if (!mod.ok || !mod.value) {
    result.compileMs = performance.now() - t0;
    result.messages.push(...mod.errors.map(toMessage));
    return result;
  }

  // Compilation is not finished until getCompilationInfo() resolves —
  // createShaderModule is asynchronous under the hood in most implementations.
  let info: GPUCompilationInfo | null = null;
  try {
    info = await mod.value.getCompilationInfo();
  } catch (e) {
    result.messages.push({ type: 'error', message: String(e), lineNum: 0 });
  }
  result.compileMs = performance.now() - t0;

  if (info) {
    for (const m of info.messages) {
      result.messages.push({
        type: m.type as ShaderMessage['type'],
        message: m.message,
        lineNum: m.lineNum,
      });
    }
  }
  result.compiled = !result.messages.some((m) => m.type === 'error');
  if (!result.compiled) return result;

  // Compiling does not mean a pipeline can be built — the real translation to
  // the backend language happens here.
  const built = await capture<GPUComputePipeline | GPURenderPipeline>(device, () => {
    if (spec.pipeline === 'compute') {
      return device.createComputePipelineAsync({
        layout: 'auto',
        compute: { module: mod.value!, entryPoint: 'cs' },
      });
    }
    return device.createRenderPipelineAsync({
      layout: 'auto',
      vertex: { module: mod.value!, entryPoint: 'vs' },
      fragment: {
        module: mod.value!,
        entryPoint: 'fs',
        targets: [{ format: 'rgba8unorm' }],
      },
    });
  });

  result.pipelineCreated = built.ok;
  if (!built.ok) result.messages.push(...built.errors.map(toMessage));

  return result;
}

function toMessage(text: string): ShaderMessage {
  return { type: 'error', message: text, lineNum: 0 };
}
