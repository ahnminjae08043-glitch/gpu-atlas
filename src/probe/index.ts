// 프로브 오케스트레이션.

import type { AtlasProfile, ProbeOptions, VerifiedCapabilities } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';
import { acquire, readEnvironment, WebGPUUnavailable } from './adapter.js';
import { probeFormats } from './formats.js';
import { probeShaders } from './shaders.js';
import { probeLimits } from './limits.js';
import { runBenchmarks } from './bench.js';
import { analyze } from './discrepancies.js';

/** 단계별 진행 비중 — 벤치가 압도적으로 오래 걸린다 */
const WEIGHTS = { formats: 0.25, shaders: 0.1, limits: 0.15, bench: 0.5 };

export async function probe(options: ProbeOptions = {}): Promise<AtlasProfile> {
  const {
    powerPreference,
    benchmark = true,
    benchSamples = 7,
    onProgress,
    formats: onlyFormats,
  } = options;

  const started = performance.now();
  const environment = await readEnvironment();

  const base: AtlasProfile = {
    schema: SCHEMA_VERSION,
    capturedAt: new Date().toISOString(),
    fingerprint: '',
    environment,
    adapter: null,
    declared: null,
    verified: null,
    benchmarks: null,
    discrepancies: [],
    elapsedMs: 0,
  };

  let acquired;
  try {
    acquired = await acquire(powerPreference);
  } catch (e) {
    return {
      ...base,
      unavailable: e instanceof WebGPUUnavailable ? e.message : describe(e),
      fingerprint: fingerprint(environment.browser, environment.browserVersion, null),
      elapsedMs: performance.now() - started,
    };
  }

  const { device, identity, declared, denied, lost } = acquired;

  // 디바이스가 중간에 죽으면 그 뒤 결과는 전부 무의미하다. 감시만 걸어둔다.
  let deviceLostReason: string | undefined;
  lost.then((info) => {
    deviceLostReason = `${info.reason}: ${info.message}`;
  });

  const declaredFeatures = new Set(declared.features);
  let done = 0;
  const step = (stage: string, weight: number) => (ratio: number) =>
    onProgress?.(stage, done + weight * ratio);

  const verified: VerifiedCapabilities = {
    formats: [],
    shaders: [],
    limits: [],
    deviceLost: false,
  };

  try {
    onProgress?.('포맷 검증', done);
    verified.formats = await probeFormats(
      device, declaredFeatures, onlyFormats, step('포맷 검증', WEIGHTS.formats),
    );
    done += WEIGHTS.formats;

    onProgress?.('셰이더 컴파일', done);
    verified.shaders = await probeShaders(
      device, declaredFeatures, step('셰이더 컴파일', WEIGHTS.shaders),
    );
    done += WEIGHTS.shaders;

    onProgress?.('limit 검증', done);
    verified.limits = await probeLimits(
      device, declared.limits, step('limit 검증', WEIGHTS.limits),
    );
    done += WEIGHTS.limits;
  } catch (e) {
    verified.deviceLost = true;
    verified.deviceLostReason = deviceLostReason ?? describe(e);
  }

  let benchmarks = null;
  if (benchmark && !verified.deviceLost) {
    onProgress?.('벤치마크', done);
    try {
      benchmarks = await runBenchmarks(device, benchSamples, step('벤치마크', WEIGHTS.bench));
    } catch (e) {
      verified.deviceLostReason = deviceLostReason ?? describe(e);
    }
  }
  onProgress?.('완료', 1);

  if (deviceLostReason) {
    verified.deviceLost = true;
    verified.deviceLostReason = deviceLostReason;
  }

  const discrepancies = analyze(
    verified.formats, verified.shaders, verified.limits, benchmarks, declaredFeatures,
  );

  // device 를 요청할 때 거절당한 것도 불일치다.
  for (const d of denied) {
    discrepancies.push({
      kind: 'limit-not-honored',
      subject: d,
      detail: 'adapter 가 신고한 값을 requestDevice 에서 그대로 요구했는데 거절당했다',
      severity: 'degraded',
    });
  }

  const profile: AtlasProfile = {
    ...base,
    fingerprint: fingerprint(environment.browser, environment.browserVersion, identity),
    adapter: identity,
    declared,
    verified,
    benchmarks,
    discrepancies,
    elapsedMs: Math.round(performance.now() - started),
  };

  device.destroy();
  return profile;
}

/**
 * 같은 기기+브라우저 조합을 묶기 위한 해시.
 * 개인 식별용이 아니다 — 어댑터 신원과 브라우저 메이저 버전만 쓴다.
 */
function fingerprint(
  browser: string,
  version: string,
  identity: { vendor: string; architecture: string; device: string; description: string } | null,
): string {
  const major = version.split('.')[0] ?? '';
  const parts = [
    browser,
    major,
    identity?.vendor ?? '',
    identity?.architecture ?? '',
    identity?.device ?? '',
    identity?.description ?? '',
  ];
  return fnv1a(parts.join('|'));
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
