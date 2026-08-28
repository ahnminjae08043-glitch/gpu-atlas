// gpu-atlas — what WebGPU actually does on this device.
//
//   import { probe } from 'gpu-atlas';
//   const profile = await probe();
//   console.log(profile.discrepancies);   // what to watch out for here

export { probe } from './probe/index.js';
export { FORMATS, findMeta } from './probe/format-table.js';
export type { FormatMeta, FormatKind } from './probe/format-table.js';

export { compareProfiles, formatComparison, describeDevice } from './compare.js';
export type {
  Comparison,
  FormatOptions,
  DeviceRef,
  FeatureDiff,
  FormatDiff,
  LimitDiff,
  BenchDiff,
} from './compare.js';

export { SCHEMA_VERSION, MIN_COMPARABLE_BENCHMARK_SCHEMA } from './types.js';
export type {
  AtlasProfile,
  ProbeOptions,
  EnvironmentInfo,
  AdapterIdentity,
  DeclaredCapabilities,
  VerifiedCapabilities,
  FormatSupport,
  ShaderCase,
  ShaderMessage,
  LimitProbe,
  BenchResult,
  BenchmarkResults,
  Discrepancy,
  DiscrepancyKind,
} from './types.js';

import type { AtlasProfile, Discrepancy } from './types.js';

/** Whether WebGPU could not be used at all */
export function isUnavailable(profile: AtlasProfile): boolean {
  return profile.unavailable !== undefined;
}

/** Only the problems that will actually break code */
export function breakingIssues(profile: AtlasProfile): Discrepancy[] {
  return profile.discrepancies.filter((d) => d.severity === 'breaking');
}

/** Formats verified to work as render targets on this device */
export function renderableFormats(profile: AtlasProfile): string[] {
  return (profile.verified?.formats ?? [])
    .filter((f) => f.renderable)
    .map((f) => f.format);
}

/** Formats verified to be readable from a shader */
export function sampleableFormats(profile: AtlasProfile): string[] {
  return (profile.verified?.formats ?? [])
    .filter((f) => f.sampleable)
    .map((f) => f.format);
}

/**
 * Pick the first candidate this device actually supports.
 * The result is measured rather than declared, so whatever comes back works.
 */
export function pickFormat(
  profile: AtlasProfile,
  candidates: string[],
  usage: 'render' | 'sample' | 'storage' = 'render',
): string | null {
  const formats = profile.verified?.formats ?? [];
  for (const c of candidates) {
    const f = formats.find((x) => x.format === c);
    if (!f) continue;
    if (usage === 'render' && f.renderable) return c;
    if (usage === 'sample' && f.sampleable) return c;
    if (usage === 'storage' && f.storageWritable) return c;
  }
  return null;
}

/** Look up a benchmark result by id */
export function benchmark(profile: AtlasProfile, id: string) {
  return profile.benchmarks?.results.find((r) => r.id === id) ?? null;
}
