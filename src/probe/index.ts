// Probe orchestration.

import type { AtlasProfile, ProbeOptions, VerifiedCapabilities } from '../types.js';
import { SCHEMA_VERSION } from '../types.js';
import { acquire, readEnvironment, WebGPUUnavailable } from './adapter.js';
import { probeFormats } from './formats.js';
import { probeShaders } from './shaders.js';
import { probeLimits } from './limits.js';
import { runBenchmarks } from './bench.js';
import { analyze } from './discrepancies.js';
import { fingerprint } from './fingerprint.js';

/** Relative weight of each stage — benchmarking dominates */
const WEIGHTS = { formats: 0.25, shaders: 0.1, limits: 0.15, bench: 0.5 };

export async function probe(options: ProbeOptions = {}): Promise<AtlasProfile> {
  const {
    powerPreference,
    benchmark = true,
    onProgress,
    formats: onlyFormats,
  } = options;

  // Zero samples produce no measurement at all and a huge count runs for hours;
  // neither is a request worth honouring literally.
  const benchSamples = clamp(options.benchSamples ?? 7, 1, 99);

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
      fingerprint: await fingerprint({
        browser: environment.browser,
        browserVersion: environment.browserVersion,
        vendor: '',
        architecture: '',
        device: '',
        description: '',
      }),
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

  // A progress handler is UI code, and UI code throws. Losing a completed set
  // of measurements because a progress bar failed would be an absurd trade.
  const report = (stage: string, ratio: number) => {
    try {
      onProgress?.(stage, ratio);
    } catch {
      // The caller's problem, not the probe's.
    }
  };
  const step = (stage: string, weight: number) => (ratio: number) =>
    report(stage, done + weight * ratio);

  const verified: VerifiedCapabilities = {
    formats: [],
    shaders: [],
    limits: [],
    deviceLost: false,
  };

  try {
    report('formats', done);
    verified.formats = await probeFormats(
      device, declaredFeatures, onlyFormats, step('formats', WEIGHTS.formats),
    );
    done += WEIGHTS.formats;

    report('shaders', done);
    verified.shaders = await probeShaders(
      device, declaredFeatures, step('shaders', WEIGHTS.shaders),
    );
    done += WEIGHTS.shaders;

    report('limits', done);
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
    report('benchmarks', done);
    try {
      benchmarks = await runBenchmarks(device, benchSamples, step('benchmarks', WEIGHTS.bench));
    } catch (e) {
      verified.deviceLostReason = deviceLostReason ?? describe(e);
    }
  }
  report('done', 1);

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
    fingerprint: await fingerprint({
      browser: environment.browser,
      browserVersion: environment.browserVersion,
      vendor: identity.vendor,
      architecture: identity.architecture,
      device: identity.device,
      description: identity.description,
    }),
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

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low;
  return Math.min(high, Math.max(low, Math.round(value)));
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
