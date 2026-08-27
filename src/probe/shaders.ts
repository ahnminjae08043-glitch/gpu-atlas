// WGSL 컴파일 검증.
//
// 여기 있는 케이스들은 전부 유효한 WGSL 이다. 그런데도 구현체마다 결과가 갈린다 —
// Chrome 은 Dawn(Tint), Firefox 는 wgpu(naga), Safari 는 자체 컴파일러를 쓰고
// 각자 다른 방식으로 백엔드 셰이더 언어(HLSL/MSL/SPIR-V)로 번역하기 때문이다.
// 컴파일 시간도 같이 잰다. 느린 기기에서는 이게 첫 프레임 지연의 주범이다.

import type { ShaderCase, ShaderMessage } from '../types.js';
import { capture } from './errors.js';

interface CaseSpec {
  id: string;
  description: string;
  code: string;
  /** 컴파일 후 파이프라인까지 만들어봐야 하는 케이스 */
  pipeline?: 'compute' | 'render';
  /** 이 feature 가 없으면 건너뛴다 */
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
    description: '가장 단순한 렌더 파이프라인 — 다른 결과의 기준선',
    pipeline: 'render',
    code: `${VS}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.); }`,
  },
  {
    id: 'uniform-dynamic-index',
    description: '유니폼 배열의 동적 인덱싱 — 백엔드에 따라 클램프 코드가 붙거나 느려진다',
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
    description: '중첩 루프 + 조건부 break — 제어흐름 평탄화에서 갈리는 지점',
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
    description: 'var<function> 포인터 전달 — naga 와 tint 의 처리 차이가 드러난다',
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
    description: '워크그룹 메모리 + 아토믹 + 배리어',
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
    description: '런타임 크기 배열 + arrayLength — 바인딩 메타데이터 처리 확인',
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
    description: '중첩 구조체 정렬/스트라이드 — 백엔드 레이아웃 계산이 갈리는 고전적 지점',
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
    description: 'override 상수 — 파이프라인 생성 시점 특수화. 지원이 고르지 않았던 기능',
    pipeline: 'compute',
    code: `
override tileSize: u32 = 8u;
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(1) fn cs() { out[0] = tileSize; }`,
  },
  {
    id: 'textureSampleLevel-uniform',
    description: '비균일 제어흐름 밖에서의 텍스처 샘플링 — 균일성 분석 구현 차이',
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
    description: '큰 셰이더 — 컴파일 시간을 재기 위한 케이스',
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
    description: 'f16 연산 — shader-f16 feature. 모바일 성능의 핵심인데 지원이 갈린다',
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
        compiled: false,
        pipelineCreated: false,
        messages: [{
          type: 'info',
          message: `${spec.requiresFeature} 미지원으로 건너뜀`,
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

  // getCompilationInfo 까지 받아야 컴파일이 실제로 끝난 것이다.
  // createShaderModule 은 많은 구현에서 비동기로 처리된다.
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

  // 컴파일이 됐다고 파이프라인이 만들어지는 건 아니다. 실제 번역은 여기서 일어난다.
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
