// limit 실검증.
//
// adapter.limits.maxBufferSize 가 2GB 라고 신고해도, 실제로 그 크기를 할당하면
// 거절당하는 기기가 흔하다. 선언값을 그대로 믿고 짠 코드가 특정 기기에서만
// 죽는 전형적인 이유다. 여기서는 선언값부터 시작해 이분탐색으로 진짜 상한을 찾는다.

import type { LimitProbe } from '../types.js';
import { dispose, works } from './errors.js';

/** 이분탐색 횟수 상한 — 정밀도와 소요시간의 절충 */
const BISECT_STEPS = 10;

type Tester = (device: GPUDevice, value: number) => Promise<{ ok: boolean; errors: string[] }>;

interface LimitSpec {
  limit: string;
  test: Tester;
  /** 이분탐색의 하한 (이 값은 반드시 된다고 보는 값) */
  floor: number;
}

const SPECS: LimitSpec[] = [
  {
    limit: 'maxBufferSize',
    floor: 256 * 1024 * 1024,
    test: (device, size) =>
      works(device, () => {
        const b = device.createBuffer({ size: align4(size), usage: GPUBufferUsage.STORAGE });
        // 즉시 해제한다. 검증하려는 건 할당이 되느냐지, 유지할 수 있느냐가 아니다.
        queueMicrotask(() => dispose(b));
        return b;
      }),
  },
  {
    limit: 'maxStorageBufferBindingSize',
    floor: 128 * 1024 * 1024,
    test: (device, size) =>
      works(device, () => {
        const buf = device.createBuffer({
          size: align4(size),
          usage: GPUBufferUsage.STORAGE,
        });
        const bgl = device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.COMPUTE,
            buffer: { type: 'storage' },
          }],
        });
        const bg = device.createBindGroup({
          layout: bgl,
          entries: [{ binding: 0, resource: { buffer: buf, size: align4(size) } }],
        });
        queueMicrotask(() => dispose(buf));
        return bg;
      }),
  },
  {
    limit: 'maxUniformBufferBindingSize',
    floor: 16 * 1024,
    test: (device, size) =>
      works(device, () => {
        const buf = device.createBuffer({
          size: align16(size),
          usage: GPUBufferUsage.UNIFORM,
        });
        const bgl = device.createBindGroupLayout({
          entries: [{
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: 'uniform' },
          }],
        });
        const bg = device.createBindGroup({
          layout: bgl,
          entries: [{ binding: 0, resource: { buffer: buf, size: align16(size) } }],
        });
        queueMicrotask(() => dispose(buf));
        return bg;
      }),
  },
  {
    limit: 'maxTextureDimension2D',
    floor: 2048,
    test: (device, size) =>
      works(device, () => {
        // [n, n] 으로 잡으면 n=16384 에서 1GB 가 된다. 폭을 재는 게 목적이므로 높이는 1 로 둔다.
        const t = device.createTexture({
          size: [Math.floor(size), 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        });
        queueMicrotask(() => dispose(t));
        return t;
      }),
  },
  {
    limit: 'maxTextureArrayLayers',
    floor: 256,
    test: (device, layers) =>
      works(device, () => {
        const t = device.createTexture({
          size: [4, 4, Math.floor(layers)],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
          dimension: '2d',
        });
        queueMicrotask(() => dispose(t));
        return t;
      }),
  },
  {
    limit: 'maxComputeWorkgroupStorageSize',
    floor: 16 * 1024,
    test: (device, bytes) =>
      works(device, async () => {
        const count = Math.max(1, Math.floor(bytes / 16));
        const module = device.createShaderModule({
          code: `
var<workgroup> scratch: array<vec4f, ${count}>;
@group(0) @binding(0) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(1) fn cs() {
  scratch[0] = vec4f(1.);
  out[0] = scratch[0].x;
}`,
        });
        return device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'cs' },
        });
      }),
  },
  {
    limit: 'maxComputeInvocationsPerWorkgroup',
    floor: 64,
    test: (device, n) =>
      works(device, async () => {
        const module = device.createShaderModule({
          code: `
@group(0) @binding(0) var<storage, read_write> out: array<u32>;
@compute @workgroup_size(${Math.floor(n)}) fn cs(@builtin(local_invocation_id) lid: vec3u) {
  out[0] = lid.x;
}`,
        });
        return device.createComputePipelineAsync({
          layout: 'auto',
          compute: { module, entryPoint: 'cs' },
        });
      }),
  },
];

export async function probeLimits(
  device: GPUDevice,
  declared: Record<string, number>,
  onProgress?: (ratio: number) => void,
): Promise<LimitProbe[]> {
  const out: LimitProbe[] = [];

  for (let i = 0; i < SPECS.length; i++) {
    const spec = SPECS[i];
    onProgress?.((i + 1) / SPECS.length);

    const declaredValue = declared[spec.limit];
    if (typeof declaredValue !== 'number' || declaredValue <= 0) continue;

    // 먼저 선언값 그대로 시도한다. 되면 더 볼 것 없다.
    const full = await spec.test(device, declaredValue);
    if (full.ok) {
      out.push({
        limit: spec.limit,
        declared: declaredValue,
        achieved: declaredValue,
        honored: true,
      });
      continue;
    }

    // 선언값이 거절됐다. 실제 상한을 찾는다.
    const achieved = await bisect(device, spec, Math.min(spec.floor, declaredValue), declaredValue);
    out.push({
      limit: spec.limit,
      declared: declaredValue,
      achieved,
      honored: false,
      error: full.errors[0] ?? '알 수 없는 이유로 거절됨',
    });
  }

  return out;
}

/** lo 는 된다고 보고, hi 는 안 된다고 확인된 상태에서 진짜 경계를 찾는다 */
async function bisect(
  device: GPUDevice,
  spec: LimitSpec,
  lo: number,
  hi: number,
): Promise<number> {
  // 하한조차 안 되면 아래로 더 내려가야 한다.
  let low = lo;
  let loOk = (await spec.test(device, low)).ok;
  while (!loOk && low > 1) {
    low = Math.floor(low / 2);
    loOk = (await spec.test(device, low)).ok;
  }
  if (!loOk) return 0;

  let high = hi;
  for (let i = 0; i < BISECT_STEPS && high - low > 1; i++) {
    const mid = low + Math.floor((high - low) / 2);
    if ((await spec.test(device, mid)).ok) low = mid;
    else high = mid;
  }
  return low;
}

const align4 = (n: number) => Math.floor(n / 4) * 4;
const align16 = (n: number) => Math.floor(n / 16) * 16;
