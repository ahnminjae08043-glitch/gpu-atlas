// 어댑터/디바이스 확보와 환경 수집.

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
  /** 요청한 feature/limit 중 실제로 받지 못한 것 */
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
    throw new WebGPUUnavailable('navigator.gpu 가 없다 — 이 브라우저는 WebGPU 를 지원하지 않는다');
  }

  const adapter = await navigator.gpu.requestAdapter(
    powerPreference ? { powerPreference } : undefined,
  );
  if (!adapter) {
    throw new WebGPUUnavailable(
      'requestAdapter 가 null 을 반환했다 — WebGPU API 는 있지만 쓸 수 있는 어댑터가 없다',
    );
  }

  const identity = await readIdentity(adapter, powerPreference);

  // 선언된 모든 feature/limit 을 요청한다. 여기서 거절당하는 것 자체가 데이터다.
  const features = [...adapter.features] as GPUFeatureName[];
  const limits = limitsToRecord(adapter.limits);

  const denied: string[] = [];
  let device = await tryDevice(adapter, features, limits);

  if (!device) {
    // limits 를 통째로 요구하면 거절하는 구현이 있다. feature 만 요청해본다.
    denied.push('requiredLimits(전체)');
    device = await tryDevice(adapter, features, undefined);
  }
  if (!device) {
    // feature 도 문제면 하나씩 빼면서 살아남는 조합을 찾는다.
    denied.push('requiredFeatures(전체)');
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
      'requestDevice 가 계속 실패했다 — 어댑터는 있는데 디바이스를 만들 수 없다',
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
  // 최신 스펙은 동기 프로퍼티, 구버전은 requestAdapterInfo(). 둘 다 받는다.
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
    // isFallbackAdapter 는 adapter 와 info 양쪽에 있었던 이력이 있다.
    isFallbackAdapter:
      (adapter as { isFallbackAdapter?: boolean }).isFallbackAdapter ??
      (info as { isFallbackAdapter?: boolean } | undefined)?.isFallbackAdapter ??
      false,
    powerPreference: powerPreference ?? 'default',
  };
}

function limitsToRecord(limits: GPUSupportedLimits): Record<string, number> {
  const out: Record<string, number> = {};
  // GPUSupportedLimits 는 일반 객체가 아니라 프로토타입에 getter 가 달려 있다.
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

// ── 환경 ────────────────────────────────────────────────

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
      // 권한/구현 문제로 실패해도 UA 파싱으로 넘어간다.
    }
  }

  const parsed = parseUA(ua);

  return {
    userAgent: ua,
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
  // 순서가 중요하다 — Edge 는 Chrome 을, Chrome 은 Safari 를 UA 에 포함한다.
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

// UA-CH 타입 (lib.dom 에 아직 없다)
interface NavigatorUAData {
  brands: Array<{ brand: string; version: string }>;
  mobile: boolean;
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<{
    platformVersion?: string;
    fullVersionList?: Array<{ brand: string; version: string }>;
  }>;
}
