// gpu-atlas — WebGPU 가 이 기기에서 실제로 무엇을 할 수 있는지 측정한다.
//
//   import { probe } from 'gpu-atlas';
//   const profile = await probe();
//   console.log(profile.discrepancies);   // 이 기기에서 조심해야 할 것들

export { probe } from './probe/index.js';
export { FORMATS, findMeta } from './probe/format-table.js';
export type { FormatMeta, FormatKind } from './probe/format-table.js';

export { SCHEMA_VERSION } from './types.js';
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

/** WebGPU 를 아예 못 쓰는 환경인지 */
export function isUnavailable(profile: AtlasProfile): boolean {
  return profile.unavailable !== undefined;
}

/** 코드가 실제로 죽는 문제만 추린다 */
export function breakingIssues(profile: AtlasProfile): Discrepancy[] {
  return profile.discrepancies.filter((d) => d.severity === 'breaking');
}

/** 어떤 포맷을 이 기기에서 렌더 타겟으로 써도 되는지 */
export function renderableFormats(profile: AtlasProfile): string[] {
  return (profile.verified?.formats ?? [])
    .filter((f) => f.renderable)
    .map((f) => f.format);
}

/** 어떤 포맷을 셰이더에서 읽을 수 있는지 */
export function sampleableFormats(profile: AtlasProfile): string[] {
  return (profile.verified?.formats ?? [])
    .filter((f) => f.sampleable)
    .map((f) => f.format);
}

/**
 * 후보 포맷 목록에서 이 기기가 실제로 지원하는 첫 번째를 고른다.
 * 선언이 아니라 실측 기준이라, 이 함수가 돌려준 포맷은 반드시 동작한다.
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

/** 벤치 결과를 id 로 찾는다 */
export function benchmark(profile: AtlasProfile, id: string) {
  return profile.benchmarks?.results.find((r) => r.id === id) ?? null;
}
