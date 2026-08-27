// 불일치 판정.
//
// 이 파일이 하는 일이 gpu-atlas 의 본론이다. 선언과 실측이 어긋난 지점을 뽑아내고,
// 그게 코드를 죽이는 문제인지(breaking) 성능만 깎는 문제인지(degraded) 구분한다.
// 여기서 나온 목록이 곧 "이 기기에서 조심해야 할 것들"이다.

import type {
  Discrepancy,
  FormatSupport,
  LimitProbe,
  ShaderCase,
  BenchmarkResults,
} from '../types.js';
import { findMeta, expectationsFor, toleratesExtraStorage } from './format-table.js';

export function analyze(
  formats: FormatSupport[],
  shaders: ShaderCase[],
  limits: LimitProbe[],
  benchmarks: BenchmarkResults | null,
  features: Set<string>,
): Discrepancy[] {
  const out: Discrepancy[] = [];
  const lenientStorage = toleratesExtraStorage(features);

  for (const f of formats) {
    const meta = findMeta(f.format);

    // feature 가 있다고 신고해놓고 정작 텍스처를 못 만드는 경우.
    if (f.featureDeclared && !f.creatable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: f.requiresFeature
          ? `${f.requiresFeature} 가 선언돼 있는데 createTexture 가 실패한다: ${first(f.errors)}`
          : `코어 포맷인데 createTexture 가 실패한다: ${first(f.errors)}`,
        severity: 'breaking',
      });
      continue;
    }

    // 만들어지긴 하는데 셰이더에서 못 읽는 경우 — 더 고약하다. 조용히 잘못 그려진다.
    if (f.creatable && !f.sampleable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `텍스처는 만들어지는데 셰이더에서 샘플링이 안 된다: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }

    // 선언되지 않은 feature 의 포맷이 실제로는 동작하는 경우.
    // 여기 기대서 코드를 짜면 안 되지만, 구현 차이를 보여주는 신호다.
    if (!f.featureDeclared && f.creatable) {
      out.push({
        kind: 'format-usable-not-declared',
        subject: f.format,
        detail: `${f.requiresFeature} 가 선언에 없는데 텍스처 생성은 성공한다`,
        severity: 'note',
      });
    }

    if (!meta || !f.creatable) continue;

    // 코어 기준선을 이 기기의 feature 만큼 올린 뒤에 비교한다.
    const expect = expectationsFor(meta, features);

    // 스펙이 렌더 가능하다고 정한 포맷인데 실제로 안 되는 경우.
    if (expect.renderable && !f.renderable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `스펙상 렌더 타겟이 돼야 하는데 렌더패스가 실패한다: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }
    if (expect.blendable && f.renderable && !f.blendable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: '스펙상 블렌딩이 돼야 하는데 블렌드 파이프라인 생성이 실패한다',
        severity: 'degraded',
      });
    }
    if (expect.storage && !f.storageWritable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `스펙상 스토리지 텍스처가 돼야 하는데 실패한다: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }
    // 반대 방향 — 스펙보다 관대한 구현.
    if (!expect.storage && f.storageWritable && !lenientStorage) {
      out.push({
        kind: 'format-usable-not-declared',
        subject: f.format,
        detail: '스펙상 스토리지 텍스처가 아닌데 이 구현에서는 동작한다',
        severity: 'note',
      });
    }
  }

  for (const l of limits) {
    if (l.honored) continue;
    const ratio = l.declared > 0 ? l.achieved / l.declared : 0;
    out.push({
      kind: 'limit-not-honored',
      subject: l.limit,
      detail:
        `${fmt(l.declared)} 을 신고했지만 실제로는 ${fmt(l.achieved)} 까지만 된다` +
        ` (${(ratio * 100).toFixed(0)}%). ${l.error ?? ''}`.trimEnd(),
      // 절반도 못 미치면 선언값 믿고 짠 코드가 그대로 죽는다.
      severity: ratio < 0.5 ? 'breaking' : 'degraded',
    });
  }

  for (const s of shaders) {
    const skipped = s.messages.some((m) => m.type === 'info' && m.message.includes('건너뜀'));
    if (skipped) continue;

    if (!s.compiled) {
      out.push({
        kind: 'shader-compile-failure',
        subject: s.id,
        detail: `${s.description} — 컴파일 실패: ${firstError(s)}`,
        severity: 'breaking',
      });
    } else if (!s.pipelineCreated) {
      out.push({
        kind: 'shader-pipeline-failure',
        subject: s.id,
        detail: `${s.description} — 컴파일은 됐는데 파이프라인 생성에서 실패: ${firstError(s)}`,
        severity: 'breaking',
      });
    }
  }

  if (benchmarks) {
    for (const b of benchmarks.results) {
      if (b.failed) {
        out.push({
          kind: 'performance-cliff',
          subject: b.id,
          detail: `벤치를 완주하지 못했다: ${b.failed}`,
          severity: 'degraded',
        });
      } else if (b.variation > 0.35) {
        // 측정 자체가 흔들린다는 건 스로틀링이나 다른 부하가 있다는 뜻이다.
        out.push({
          kind: 'performance-cliff',
          subject: b.id,
          detail:
            `측정 변동이 ${(b.variation * 100).toFixed(0)}% 로 크다 —` +
            ' 스로틀링이나 외부 부하가 의심된다. 이 수치는 신뢰하기 어렵다',
          severity: 'note',
        });
      }
    }
  }

  return out;
}

function first(errors: string[]): string {
  return errors[0] ?? '에러 메시지 없음';
}

function firstError(s: ShaderCase): string {
  return s.messages.find((m) => m.type === 'error')?.message ?? '에러 메시지 없음';
}

function fmt(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return String(n);
}
