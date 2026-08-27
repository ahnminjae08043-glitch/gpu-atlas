// 텍스처 포맷 실검증.
//
// adapter.features 에 'texture-compression-bc' 가 있다는 것과, 그 기기에서 실제로
// bc7 텍스처를 만들어 샘플링할 수 있다는 것은 별개의 주장이다. 여기서는 후자만 믿는다.
// 모든 항목은 실제로 리소스를 만들고, 파이프라인을 세우고, 렌더패스를 돌려서 판정한다.

import type { FormatSupport } from '../types.js';
import { FORMATS, sampleTypeOf, wgslTextureType, type FormatMeta } from './format-table.js';
import { capture, dispose, works } from './errors.js';

const VERTEX_WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}`;

/** 검증 중 결과를 받아낼 공용 컬러 타겟 */
interface Scratch {
  target: GPUTexture;
  view: GPUTextureView;
}

export async function probeFormats(
  device: GPUDevice,
  declaredFeatures: Set<string>,
  only?: string[],
  onProgress?: (ratio: number) => void,
): Promise<FormatSupport[]> {
  const list = only
    ? FORMATS.filter((f) => only.includes(f.format))
    : FORMATS;

  const scratchTex = device.createTexture({
    size: [4, 4],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });
  const scratch: Scratch = { target: scratchTex, view: scratchTex.createView() };

  const out: FormatSupport[] = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await probeOne(device, list[i], declaredFeatures, scratch));
    onProgress?.((i + 1) / list.length);
  }

  dispose(scratchTex);
  return out;
}

async function probeOne(
  device: GPUDevice,
  meta: FormatMeta,
  declaredFeatures: Set<string>,
  scratch: Scratch,
): Promise<FormatSupport> {
  const result: FormatSupport = {
    format: meta.format,
    requiresFeature: meta.requiresFeature,
    featureDeclared: meta.requiresFeature ? declaredFeatures.has(meta.requiresFeature) : true,
    creatable: false,
    sampleable: false,
    renderable: false,
    blendable: false,
    storageWritable: false,
    multisample4x: false,
    errors: [],
  };

  const [w, h] = meta.block ?? [4, 4];

  // 1. 만들 수 있는가
  const created = await capture(device, () =>
    device.createTexture({
      size: [w, h],
      format: meta.format as GPUTextureFormat,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }),
  );
  result.creatable = created.ok;
  if (!created.ok) {
    result.errors.push(...prefix('create', created.errors));
    // 만들지도 못하면 나머지는 볼 것도 없다.
    return result;
  }
  const tex = created.value!;

  // 2. 셰이더에서 읽을 수 있는가
  const sampled = await probeSampleable(device, meta, tex, scratch);
  result.sampleable = sampled.ok;
  if (!sampled.ok) result.errors.push(...prefix('sample', sampled.errors));
  dispose(tex);

  // 3. 렌더 타겟이 되는가 / 4. 블렌딩이 되는가
  if (meta.kind === 'compressed') {
    // 압축 포맷은 렌더 타겟이 될 수 없다. 시도 자체가 의미 없다.
  } else if (meta.kind === 'depth') {
    const r = await probeDepthRenderable(device, meta);
    result.renderable = r.ok;
    if (!r.ok) result.errors.push(...prefix('render', r.errors));
  } else {
    const r = await probeColorRenderable(device, meta, false);
    result.renderable = r.ok;
    if (!r.ok) result.errors.push(...prefix('render', r.errors));

    if (result.renderable) {
      const b = await probeColorRenderable(device, meta, true);
      result.blendable = b.ok;
      if (!b.ok) result.errors.push(...prefix('blend', b.errors));
    }
  }

  // 5. 스토리지 텍스처로 쓸 수 있는가
  if (meta.kind === 'color') {
    const s = await probeStorage(device, meta);
    result.storageWritable = s.ok;
    if (!s.ok) result.errors.push(...prefix('storage', s.errors));
  }

  // 6. 4x MSAA
  if (result.renderable) {
    const m = await probeMultisample(device, meta);
    result.multisample4x = m.ok;
    if (!m.ok) result.errors.push(...prefix('msaa4x', m.errors));
  }

  return result;
}

// ── 개별 검증 ───────────────────────────────────────────

async function probeSampleable(
  device: GPUDevice,
  meta: FormatMeta,
  tex: GPUTexture,
  scratch: Scratch,
): Promise<{ ok: boolean; errors: string[] }> {
  const needsSampler = meta.kind === 'compressed';
  const sampleType = sampleTypeOf(meta);

  return works(device, async () => {
    const entries: GPUBindGroupLayoutEntry[] = [{
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType, viewDimension: '2d' },
    }];
    if (needsSampler) {
      entries.push({
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: meta.filterable ? 'filtering' : 'non-filtering' },
      });
    }

    const bgl = device.createBindGroupLayout({ entries });
    const module = device.createShaderModule({
      code: VERTEX_WGSL + sampleFragmentWGSL(meta, needsSampler),
    });

    const pipeline = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
    });

    // depth 와 stencil 을 겸하는 포맷은 뷰에서 aspect 를 골라줘야 한다.
    // 그냥 createView() 하면 두 aspect 가 다 선택돼서 바인딩이 거절된다.
    const viewDesc: GPUTextureViewDescriptor = {};
    if (meta.hasDepth && meta.hasStencil) viewDesc.aspect = 'depth-only';

    const bgEntries: GPUBindGroupEntry[] = [
      { binding: 0, resource: tex.createView(viewDesc) },
    ];
    let sampler: GPUSampler | undefined;
    if (needsSampler) {
      sampler = device.createSampler(
        meta.filterable ? { magFilter: 'linear', minFilter: 'linear' } : {},
      );
      bgEntries.push({ binding: 1, resource: sampler });
    }
    const bindGroup = device.createBindGroup({ layout: bgl, entries: bgEntries });

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: scratch.view,
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    return true;
  }, true);
}

async function probeColorRenderable(
  device: GPUDevice,
  meta: FormatMeta,
  blend: boolean,
): Promise<{ ok: boolean; errors: string[] }> {
  return works(device, async () => {
    const tex = device.createTexture({
      size: [4, 4],
      format: meta.format as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const target: GPUColorTargetState = { format: meta.format as GPUTextureFormat };
    if (blend) {
      target.blend = {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      };
    }

    const module = device.createShaderModule({
      code: VERTEX_WGSL + colorFragmentWGSL(meta),
    });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      fragment: { module, entryPoint: 'fs', targets: [target] },
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: tex.createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    // 텍스처는 제출된 작업이 끝난 뒤에 정리해야 한다.
    device.queue.onSubmittedWorkDone().then(() => dispose(tex));
    return true;
  }, true);
}

async function probeDepthRenderable(
  device: GPUDevice,
  meta: FormatMeta,
): Promise<{ ok: boolean; errors: string[] }> {
  return works(device, async () => {
    const tex = device.createTexture({
      size: [4, 4],
      format: meta.format as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    const depthStencil: GPUDepthStencilState = {
      format: meta.format as GPUTextureFormat,
    };
    if (meta.hasDepth) {
      depthStencil.depthWriteEnabled = true;
      depthStencil.depthCompare = 'always';
    }

    const module = device.createShaderModule({ code: VERTEX_WGSL });
    // 컬러 타겟 없이 깊이만 쓰는 파이프라인 — fragment 스테이지를 생략한다.
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      depthStencil,
    });

    const attachment: GPURenderPassDepthStencilAttachment = { view: tex.createView() };
    if (meta.hasDepth) {
      attachment.depthClearValue = 1;
      attachment.depthLoadOp = 'clear';
      attachment.depthStoreOp = 'store';
    }
    if (meta.hasStencil) {
      attachment.stencilClearValue = 0;
      attachment.stencilLoadOp = 'clear';
      attachment.stencilStoreOp = 'store';
    }

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: attachment,
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    device.queue.onSubmittedWorkDone().then(() => dispose(tex));
    return true;
  }, true);
}

async function probeStorage(
  device: GPUDevice,
  meta: FormatMeta,
): Promise<{ ok: boolean; errors: string[] }> {
  return works(device, async () => {
    const tex = device.createTexture({
      size: [4, 4],
      format: meta.format as GPUTextureFormat,
      usage: GPUTextureUsage.STORAGE_BINDING,
    });

    const vecType = meta.texel === 'u32' ? 'vec4u' : meta.texel === 'i32' ? 'vec4i' : 'vec4f';
    const module = device.createShaderModule({
      code: `
@group(0) @binding(0) var t: texture_storage_2d<${meta.format}, write>;
@compute @workgroup_size(1) fn cs() {
  textureStore(t, vec2i(0, 0), ${vecType}(${meta.texel === 'f32' ? '1., 0., 0., 1.' : '1, 0, 0, 1'}));
}`,
    });

    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module, entryPoint: 'cs' },
    });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: tex.createView() }],
    });

    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([enc.finish()]);
    device.queue.onSubmittedWorkDone().then(() => dispose(tex));
    return true;
  }, true);
}

async function probeMultisample(
  device: GPUDevice,
  meta: FormatMeta,
): Promise<{ ok: boolean; errors: string[] }> {
  return works(device, async () => {
    const tex = device.createTexture({
      size: [4, 4],
      format: meta.format as GPUTextureFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount: 4,
    });

    const module = device.createShaderModule({
      code: VERTEX_WGSL + (meta.kind === 'depth' ? '' : colorFragmentWGSL(meta)),
    });

    const desc: GPURenderPipelineDescriptor = {
      layout: 'auto',
      vertex: { module, entryPoint: 'vs' },
      multisample: { count: 4 },
    };
    if (meta.kind === 'depth') {
      const ds: GPUDepthStencilState = { format: meta.format as GPUTextureFormat };
      if (meta.hasDepth) {
        ds.depthWriteEnabled = true;
        ds.depthCompare = 'always';
      }
      desc.depthStencil = ds;
    } else {
      desc.fragment = {
        module,
        entryPoint: 'fs',
        targets: [{ format: meta.format as GPUTextureFormat }],
      };
    }
    const pipeline = device.createRenderPipeline(desc);

    const enc = device.createCommandEncoder();
    let pass: GPURenderPassEncoder;
    if (meta.kind === 'depth') {
      const attachment: GPURenderPassDepthStencilAttachment = { view: tex.createView() };
      if (meta.hasDepth) {
        attachment.depthClearValue = 1;
        attachment.depthLoadOp = 'clear';
        attachment.depthStoreOp = 'discard';
      }
      if (meta.hasStencil) {
        attachment.stencilClearValue = 0;
        attachment.stencilLoadOp = 'clear';
        attachment.stencilStoreOp = 'discard';
      }
      pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: attachment });
    } else {
      pass = enc.beginRenderPass({
        colorAttachments: [{
          view: tex.createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        }],
      });
    }
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
    device.queue.onSubmittedWorkDone().then(() => dispose(tex));
    return true;
  }, true);
}

// ── WGSL 생성 ───────────────────────────────────────────

function sampleFragmentWGSL(meta: FormatMeta, needsSampler: boolean): string {
  const texType = wgslTextureType(meta);
  const decl = `@group(0) @binding(0) var t: ${texType};`;
  const samplerDecl = needsSampler ? '@group(0) @binding(1) var s: sampler;' : '';

  let body: string;
  if (needsSampler) {
    // 압축 포맷은 textureLoad 를 못 쓴다. 샘플링만 가능하다.
    body = 'return textureSample(t, s, vec2f(0.5, 0.5));';
  } else if (meta.kind === 'depth' && meta.hasDepth) {
    // texture_depth_2d 의 textureLoad 는 스칼라 f32 를 준다.
    body = 'let v = textureLoad(t, vec2i(0, 0), 0);\n  return vec4f(v, 0., 0., 1.);';
  } else if (meta.texel === 'f32') {
    body = 'return textureLoad(t, vec2i(0, 0), 0);';
  } else {
    body = 'let v = textureLoad(t, vec2i(0, 0), 0);\n  return vec4f(f32(v.x), f32(v.y), f32(v.z), 1.);';
  }

  return `
${decl}
${samplerDecl}
@fragment fn fs() -> @location(0) vec4f {
  ${body}
}`;
}

function colorFragmentWGSL(meta: FormatMeta): string {
  // 프래그먼트 출력 타입은 렌더 타겟 포맷의 텍셀 타입과 맞아야 한다.
  if (meta.texel === 'u32') {
    return `
@fragment fn fs() -> @location(0) vec4u {
  return vec4u(1u, 0u, 0u, 1u);
}`;
  }
  if (meta.texel === 'i32') {
    return `
@fragment fn fs() -> @location(0) vec4i {
  return vec4i(1, 0, 0, 1);
}`;
  }
  return `
@fragment fn fs() -> @location(0) vec4f {
  return vec4f(1., 0., 0., 1.);
}`;
}

function prefix(stage: string, errors: string[]): string[] {
  return errors.map((e) => `[${stage}] ${e}`);
}
