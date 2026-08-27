// Limit verification.
//
// adapter.limits.maxBufferSize may report 2GB while allocating that much gets
// refused — which is the classic reason code written against declared values
// dies on one specific device. This starts from the declared value and bisects
// down to the real ceiling.

import type { LimitProbe } from '../types.js';
import { dispose, works } from './errors.js';

/** Bisection step cap — trades precision against how long the probe takes */
const BISECT_STEPS = 10;

type Tester = (device: GPUDevice, value: number) => Promise<{ ok: boolean; errors: string[] }>;

interface LimitSpec {
  limit: string;
  test: Tester;
  /** Bisection floor — a value assumed to work */
  floor: number;
}

const SPECS: LimitSpec[] = [
  {
    limit: 'maxBufferSize',
    floor: 256 * 1024 * 1024,
    test: (device, size) =>
      works(device, () => {
        const b = device.createBuffer({ size: align4(size), usage: GPUBufferUsage.STORAGE });
        // Release immediately — the question is whether it allocates, not whether it can be held.
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
        // [n, n] would be 1GB at n=16384. Width is what is being measured, so height stays 1.
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

    // Try the declared value as-is first. If it works, there is nothing to find.
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

    // The declared value was refused. Find the real ceiling.
    const achieved = await bisect(device, spec, Math.min(spec.floor, declaredValue), declaredValue);
    out.push({
      limit: spec.limit,
      declared: declaredValue,
      achieved,
      honored: false,
      error: full.errors[0] ?? 'refused for an unreported reason',
    });
  }

  return out;
}

/** lo is assumed to work and hi is known not to — find the boundary between them */
async function bisect(
  device: GPUDevice,
  spec: LimitSpec,
  lo: number,
  hi: number,
): Promise<number> {
  // If even the floor fails, walk down until something works.
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
