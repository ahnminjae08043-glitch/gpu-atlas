// Acquiring the adapter and device, plus environment collection.

import type {
  AdapterIdentity,
  DeclaredCapabilities,
  EnvironmentInfo,
} from '../types.js';

export interface Acquired {
  adapter: GPUAdapter;
  device: GPUDevice;
  identity: AdapterIdentity;
  declared: DeclaredCapabilities;
  /** Features and limits that were requested but refused */
  denied: string[];
  lost: Promise<GPUDeviceLostInfo>;
}

export class WebGPUUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGPUUnavailable';
  }
}

export async function acquire(
  powerPreference?: GPUPowerPreference,
): Promise<Acquired> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new WebGPUUnavailable('navigator.gpu is missing — this browser has no WebGPU');
  }

  const adapter = await navigator.gpu.requestAdapter(
    powerPreference ? { powerPreference } : undefined,
  );
  if (!adapter) {
    throw new WebGPUUnavailable(
      'requestAdapter returned null — the WebGPU API exists but no usable adapter does',
    );
  }

  const identity = await readIdentity(adapter, powerPreference);

  // Ask for every declared feature and limit. Being refused here is itself data.
  const features = [...adapter.features] as GPUFeatureName[];
  const limits = limitsToRecord(adapter.limits);

  const denied: string[] = [];
  let device = await tryDevice(adapter, features, limits);

  if (!device) {
    // Some implementations refuse the full limits block. Try features alone.
    denied.push('requiredLimits (all)');
    device = await tryDevice(adapter, features, undefined);
  }
  if (!device) {
    // Features are a problem too — find a subset that survives by adding them
    // one at a time. This is greedy and order-dependent: a feature that works
    // alone but conflicts with an earlier one is recorded as denied even though
    // a different ordering would have kept it. Testing every combination is
    // exponential, and no implementation has been observed to need it.
    denied.push('requiredFeatures (all)');
    const survivors: GPUFeatureName[] = [];
    for (const f of features) {
      const d = await tryDevice(adapter, [...survivors, f], undefined);
      if (d) {
        survivors.push(f);
        d.destroy();
      } else {
        denied.push(`feature:${f}`);
      }
    }
    device = await tryDevice(adapter, survivors, undefined);
  }
  if (!device) {
    throw new WebGPUUnavailable(
      'requestDevice kept failing — there is an adapter but no device can be created from it',
    );
  }

  const declared: DeclaredCapabilities = {
    features: [...adapter.features].sort(),
    limits,
    preferredCanvasFormat: safePreferredFormat(),
  };

  return { adapter, device, identity, declared, denied, lost: device.lost };
}

async function tryDevice(
  adapter: GPUAdapter,
  features: GPUFeatureName[],
  limits: Record<string, number> | undefined,
): Promise<GPUDevice | null> {
  try {
    const desc: GPUDeviceDescriptor = { requiredFeatures: features };
    if (limits) desc.requiredLimits = limits;
    return await adapter.requestDevice(desc);
  } catch {
    return null;
  }
}

async function readIdentity(
  adapter: GPUAdapter,
  powerPreference?: GPUPowerPreference,
): Promise<AdapterIdentity> {
  // Current spec exposes a sync property; older builds had requestAdapterInfo().
  let info: GPUAdapterInfo | undefined = (adapter as { info?: GPUAdapterInfo }).info;
  if (!info) {
    const legacy = adapter as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> };
    if (typeof legacy.requestAdapterInfo === 'function') {
      try {
        info = await legacy.requestAdapterInfo();
      } catch {
        info = undefined;
      }
    }
  }

  return {
    vendor: info?.vendor ?? '',
    architecture: info?.architecture ?? '',
    device: info?.device ?? '',
    description: info?.description ?? '',
    // isFallbackAdapter has lived on both the adapter and its info over time.
    isFallbackAdapter:
      (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter ??
      (info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter ??
      false,
    powerPreference: powerPreference ?? 'default',
  };
}

function limitsToRecord(limits: GPUSupportedLimits): Record<string, number> {
  const out: Record<string, number> = {};
  // GPUSupportedLimits is not a plain object — the values are prototype getters.
  for (const key of supportedLimitKeys(limits)) {
    const v = (limits as unknown as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

function supportedLimitKeys(limits: GPUSupportedLimits): string[] {
  const keys = new Set<string>();
  let proto: object | null = Object.getPrototypeOf(limits);
  while (proto && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k !== 'constructor') keys.add(k);
    }
    proto = Object.getPrototypeOf(proto);
  }
  for (const k of Object.keys(limits)) keys.add(k);
  return [...keys].sort();
}

function safePreferredFormat(): string {
  try {
    return navigator.gpu.getPreferredCanvasFormat();
  } catch {
    return '';
  }
}

// ── Environment ─────────────────────────────────────────

export async function readEnvironment(): Promise<EnvironmentInfo> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const uaData = (navigator as { userAgentData?: NavigatorUAData }).userAgentData;

  let platform: string | undefined;
  let mobile: boolean | undefined;
  let brand: string | undefined;
  let brandVersion: string | undefined;

  if (uaData) {
    mobile = uaData.mobile;
    platform = uaData.platform;
    try {
      const high = await uaData.getHighEntropyValues(['platformVersion', 'fullVersionList']);
      const list = high.fullVersionList ?? uaData.brands;
      const primary = list?.find((b) => !/Not.?A.?Brand/i.test(b.brand));
      if (primary) {
        brand = primary.brand;
        brandVersion = primary.version;
      }
      if (high.platformVersion) platform = `${platform} ${high.platformVersion}`;
    } catch {
      // Permission or implementation gaps just fall through to UA parsing.
    }
  }

  const parsed = parseUA(ua);

  return {
    // The UA string is parsed above but deliberately not kept: everything the
    // profile needs from it is already broken out, and the raw value only adds
    // identifying detail to something people are asked to share.
    platform,
    browser: brand ?? parsed.browser,
    browserVersion: brandVersion ?? parsed.version,
    mobile: mobile ?? /Mobi|Android|iPhone|iPad/i.test(ua),
    deviceMemoryGB: (navigator as { deviceMemory?: number }).deviceMemory,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio: typeof devicePixelRatio === 'number' ? devicePixelRatio : 1,
  };
}

function parseUA(ua: string): { browser: string; version: string } {
  // Order matters — Edge's UA contains Chrome, and Chrome's contains Safari.
  const patterns: Array<[string, RegExp]> = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of patterns) {
    const m = ua.match(re);
    if (m) return { browser: name, version: m[1] };
  }
  return { browser: 'unknown', version: '' };
}

// UA-CH types (not yet in lib.dom)
interface NavigatorUAData {
  brands: Array<{ brand: string; version: string }>;
  mobile: boolean;
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<{
    platformVersion?: string;
    fullVersionList?: Array<{ brand: string; version: string }>;
  }>;
}
