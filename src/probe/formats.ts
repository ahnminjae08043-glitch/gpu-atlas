// Texture format verification.
//
// "adapter.features contains texture-compression-bc" and "this device can create
// and sample a bc7 texture" are separate claims. Only the second one is believed
// here. Every entry is decided by actually creating the resource, building the
// pipeline, and running the pass.

import type { FormatSupport } from '../types.js';
import { FORMATS, sampleTypeOf, wgslTextureType, type FormatMeta } from './format-table.js';
import { capture, dispose, works } from './errors.js';

const VERTEX_WGSL = `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1., -1.), vec2f(3., -1.), vec2f(-1., 3.));
  return vec4f(p[i], 0., 1.);
}`;

/** Shared color target that verification results get drawn into */
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

  // 1. Can it be created at all
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
    // Nothing else is worth checking if it cannot even be created.
    return result;
  }
  const tex = created.value!;

  // 2. Can a shader read it
  const sampled = await probeSampleable(device, meta, tex, scratch);
  result.sampleable = sampled.ok;
  if (!sampled.ok) result.errors.push(...prefix('sample', sampled.errors));
  dispose(tex);

  // 3. Does it work as a render target / 4. does blending work
  if (meta.kind === 'compressed') {
    // Compressed formats cannot be render targets. Nothing to try.
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

  // 5. Does it work as a storage texture
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

// ── Individual checks ───────────────────────────────────

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

    // Formats carrying both depth and stencil need an explicit aspect on the
    // view. A plain createView() selects both and the binding is rejected.
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
    // The texture can only be released once the submitted work has finished.
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
    // Depth-only pipeline — no color target, so the fragment stage is omitted.
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

// ── WGSL generation ─────────────────────────────────────

function sampleFragmentWGSL(meta: FormatMeta, needsSampler: boolean): string {
  const texType = wgslTextureType(meta);
  const decl = `@group(0) @binding(0) var t: ${texType};`;
  const samplerDecl = needsSampler ? '@group(0) @binding(1) var s: sampler;' : '';

  let body: string;
  if (needsSampler) {
    // textureLoad is not available for compressed formats — only sampling is.
    body = 'return textureSample(t, s, vec2f(0.5, 0.5));';
  } else if (meta.kind === 'depth' && meta.hasDepth) {
    // textureLoad on texture_depth_2d yields a scalar f32.
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
  // The fragment output type has to match the render target's texel type.
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
