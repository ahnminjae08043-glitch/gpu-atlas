// Discrepancy analysis.
//
// This is what gpu-atlas is for. It pulls out the places where declaration and
// measurement disagree, and separates the ones that break code (breaking) from
// the ones that only cost performance (degraded). What comes out is the list of
// things to be careful about on this device.

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

    // The feature is declared, yet the texture cannot even be created.
    if (f.featureDeclared && !f.creatable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: f.requiresFeature
          ? `${f.requiresFeature} is declared but createTexture fails: ${first(f.errors)}`
          : `core format, yet createTexture fails: ${first(f.errors)}`,
        severity: 'breaking',
      });
      continue;
    }

    // Creates fine but cannot be read from a shader — the nastier case, since it
    // tends to surface as something quietly rendering wrong.
    if (f.creatable && !f.sampleable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `the texture is created but shader sampling fails: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }

    // A format behind an undeclared feature that works anyway. Nothing to rely
    // on, but it is a signal about how this implementation differs.
    if (!f.featureDeclared && f.creatable) {
      out.push({
        kind: 'format-usable-not-declared',
        subject: f.format,
        detail: `${f.requiresFeature} is not declared, yet texture creation succeeds`,
        severity: 'note',
      });
    }

    if (!meta || !f.creatable) continue;

    // Raise the core baseline by this device's features before comparing.
    const expect = expectationsFor(meta, features);

    if (expect.renderable && !f.renderable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `should be a valid render target per spec, but the render pass fails: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }
    if (expect.blendable && f.renderable && !f.blendable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: 'should support blending per spec, but creating a blend pipeline fails',
        severity: 'degraded',
      });
    }
    if (expect.storage && !f.storageWritable) {
      out.push({
        kind: 'format-declared-not-usable',
        subject: f.format,
        detail: `should work as a storage texture per spec, but fails: ${first(f.errors)}`,
        severity: 'breaking',
      });
    }
    // The other direction — an implementation more permissive than the baseline.
    if (!expect.storage && f.storageWritable && !lenientStorage) {
      out.push({
        kind: 'format-usable-not-declared',
        subject: f.format,
        detail: 'not a storage format per spec, yet it works on this implementation',
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
        `declares ${fmt(l.declared)} but only reaches ${fmt(l.achieved)}` +
        ` (${(ratio * 100).toFixed(0)}%). ${l.error ?? ''}`.trimEnd(),
      // Below half, code written against the declared value simply dies.
      severity: ratio < 0.5 ? 'breaking' : 'degraded',
    });
  }

  for (const s of shaders) {
    if (s.skipped) continue;

    if (!s.compiled) {
      out.push({
        kind: 'shader-compile-failure',
        subject: s.id,
        detail: `${s.description} — compilation failed: ${firstError(s)}`,
        severity: 'breaking',
      });
    } else if (!s.pipelineCreated) {
      out.push({
        kind: 'shader-pipeline-failure',
        subject: s.id,
        detail: `${s.description} — compiled, but pipeline creation failed: ${firstError(s)}`,
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
          detail: `the benchmark did not complete: ${b.failed}`,
          severity: 'degraded',
        });
      } else if (b.quantized) {
        // A variation of zero here means the timer could not resolve the work,
        // not that the device was consistent. Reporting it as stable would be
        // the more misleading of the two options.
        out.push({
          kind: 'performance-cliff',
          subject: b.id,
          detail:
            `the measurement spans only ${b.ticks} timer resolution units, so it` +
            ' sits on the quantization floor. Treat this throughput as a lower' +
            ' bound rather than a measurement',
          severity: 'note',
        });
      } else if (b.variation > 0.35) {
        // Unstable measurement means throttling or competing load.
        out.push({
          kind: 'performance-cliff',
          subject: b.id,
          detail:
            `variation is ${(b.variation * 100).toFixed(0)}% — likely thermal` +
            ' throttling or external load. This number should not be trusted',
          severity: 'note',
        });
      }
    }
  }

  return out;
}

function first(errors: string[]): string {
  return errors[0] ?? 'no error message';
}

function firstError(s: ShaderCase): string {
  return s.messages.find((m) => m.type === 'error')?.message ?? 'no error message';
}

function fmt(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return String(n);
}
