// Probe orchestration.

import type { AtlasProfile, ProbeOptions, VerifiedCapabilities } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';
import { acquire, readEnvironment, WebGPUUnavailable } from './adapter.js';
import { probeFormats } from './formats.js';
import { probeShaders } from './shaders.js';
import { probeLimits } from './limits.js';
import { runBenchmarks } from './bench.js';
import { analyze } from './discrepancies.js';

/** Relative weight of each stage — benchmarking dominates */
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

  // If the device dies partway, everything after that point is meaningless.
  // Just watch for it.
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
    onProgress?.('formats', done);
    verified.formats = await probeFormats(
      device, declaredFeatures, onlyFormats, step('formats', WEIGHTS.formats),
    );
    done += WEIGHTS.formats;

    onProgress?.('shaders', done);
    verified.shaders = await probeShaders(
      device, declaredFeatures, step('shaders', WEIGHTS.shaders),
    );
    done += WEIGHTS.shaders;

    onProgress?.('limits', done);
    verified.limits = await probeLimits(
      device, declared.limits, step('limits', WEIGHTS.limits),
    );
    done += WEIGHTS.limits;
  } catch (e) {
    verified.deviceLost = true;
    verified.deviceLostReason = deviceLostReason ?? describe(e);
  }

  let benchmarks = null;
  if (benchmark && !verified.deviceLost) {
    onProgress?.('benchmarks', done);
    try {
      benchmarks = await runBenchmarks(device, benchSamples, step('benchmarks', WEIGHTS.bench));
    } catch (e) {
      verified.deviceLostReason = deviceLostReason ?? describe(e);
    }
  }
  onProgress?.('done', 1);

  if (deviceLostReason) {
    verified.deviceLost = true;
    verified.deviceLostReason = deviceLostReason;
  }

  const discrepancies = analyze(
    verified.formats, verified.shaders, verified.limits, benchmarks, declaredFeatures,
  );

  // Being refused what the adapter advertised is a discrepancy too.
  for (const d of denied) {
    discrepancies.push({
      kind: 'limit-not-honored',
      subject: d,
      detail: 'requestDevice refused values the adapter itself advertised',
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
 * Hash grouping the same device + browser combination.
 * Not an identifier for a person — only adapter identity and browser major.
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
