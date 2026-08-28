// Comparing profiles across devices.
//
// A single profile answers "what does this device do". The question people
// actually have is "will my code run on the devices my users have, and what
// budget do I get" — and that only shows up when profiles are placed side by
// side. Two devices already surface a 65x gap on one axis and 12x on another,
// which no single profile could have revealed.

import type {
  AtlasProfile, BenchResult, FormatSupport, LimitProbe,
} from './types.js';
import { MIN_COMPARABLE_BENCHMARK_SCHEMA } from './types.js';

export interface DeviceRef {
  fingerprint: string;
  /** Human-readable identity, e.g. "qualcomm adreno-7xx / Samsung Internet 30" */
  label: string;
  mobile: boolean;
  /** Index into the input array, for callers that need to get back to it */
  index: number;
  /** Schema version the profile was captured under */
  schema: number;
  /**
   * The profile predates the schema that made measurement trustworthiness
   * explicit, so its benchmark numbers are reported but never treated as
   * reliable. Capability data from such profiles is still comparable.
   */
  staleBenchmarks: boolean;
}

export interface FeatureDiff {
  feature: string;
  supportedBy: string[];
  missingFrom: string[];
}

/** A texture capability that is not uniform across the compared devices */
export interface FormatDiff {
  format: string;
  capability: 'creatable' | 'sampleable' | 'renderable' | 'blendable'
    | 'storageWritable' | 'multisample4x';
  supportedBy: string[];
  missingFrom: string[];
}

export interface LimitDiff {
  limit: string;
  /** fingerprint -> value actually achieved */
  values: Record<string, number>;
  min: number;
  max: number;
  /** max / min — how far apart the devices are */
  ratio: number;
}

export interface BenchDiff {
  id: string;
  description: string;
  unit: string;
  /** fingerprint -> throughput, null when the benchmark did not produce one */
  values: Record<string, number | null>;
  fastest: string | null;
  slowest: string | null;
  /** fastest / slowest */
  ratio: number | null;
  /**
   * Devices whose measurement should not be trusted for this benchmark, either
   * because it sat on the quantization floor or because it was too unstable.
   * A ratio computed against these is not meaningful.
   */
  unreliable: string[];
}

export interface Comparison {
  devices: DeviceRef[];
  /** Features present on some devices but not others */
  features: FeatureDiff[];
  /** Features every compared device has */
  sharedFeatures: string[];
  formats: FormatDiff[];
  limits: LimitDiff[];
  benchmarks: BenchDiff[];
  /** Profiles that could not be compared, and why */
  excluded: Array<{ index: number; reason: string }>;
}

/**
 * Lookup tables built once per profile.
 *
 * The naive version scanned the arrays inside the comparison loops, which is
 * fine for three profiles and quadratic for the collection this is meant to
 * grow into.
 */
interface Indexed {
  profile: AtlasProfile;
  features: Set<string>;
  formats: Map<string, FormatSupport>;
  limits: Map<string, LimitProbe>;
  benchmarks: Map<string, BenchResult>;
}

function index(p: AtlasProfile): Indexed {
  return {
    profile: p,
    features: new Set(p.declared!.features),
    formats: new Map(p.verified!.formats.map((f) => [f.format, f])),
    limits: new Map(p.verified!.limits.map((l) => [l.limit, l])),
    benchmarks: new Map((p.benchmarks?.results ?? []).map((r) => [r.id, r])),
  };
}

const CAPABILITIES = [
  'creatable', 'sampleable', 'renderable', 'blendable',
  'storageWritable', 'multisample4x',
] as const;

/**
 * Above this coefficient of variation a benchmark is treated as unreliable.
 * Kept fairly tight: a 21.7% reading once slipped through on a benchmark that
 * turned out to be measuring nothing at all.
 */
const UNSTABLE_ABOVE = 0.15;

export function compareProfiles(profiles: AtlasProfile[]): Comparison {
  const devices: DeviceRef[] = [];
  const usable: AtlasProfile[] = [];
  const excluded: Comparison['excluded'] = [];

  profiles.forEach((p, index) => {
    if (p.unavailable) {
      excluded.push({ index, reason: `WebGPU unavailable: ${p.unavailable}` });
      return;
    }
    if (!p.verified || !p.declared) {
      excluded.push({ index, reason: 'profile has no verified data' });
      return;
    }
    const schema = typeof p.schema === 'number' ? p.schema : 0;
    devices.push({
      fingerprint: p.fingerprint,
      label: describeDevice(p),
      mobile: p.environment.mobile,
      index,
      schema,
      staleBenchmarks: schema < MIN_COMPARABLE_BENCHMARK_SCHEMA,
    });
    usable.push(p);
  });

  const indexed = usable.map(index);

  return {
    devices,
    ...diffFeatures(indexed),
    formats: diffFormats(indexed),
    limits: diffLimits(indexed),
    benchmarks: diffBenchmarks(indexed),
    excluded,
  };
}

export function describeDevice(p: AtlasProfile): string {
  const gpu = [p.adapter?.vendor, p.adapter?.architecture]
    .filter(Boolean).join(' ') || p.adapter?.description || 'unknown GPU';
  const browser = [p.environment.browser, majorVersion(p.environment.browserVersion)]
    .filter(Boolean).join(' ');
  return browser ? `${gpu} / ${browser}` : gpu;
}

// ── Features ────────────────────────────────────────────

function diffFeatures(profiles: Indexed[]): {
  features: FeatureDiff[];
  sharedFeatures: string[];
} {
  const all = new Set<string>();
  for (const p of profiles) for (const f of p.features) all.add(f);

  const features: FeatureDiff[] = [];
  const shared: string[] = [];

  for (const feature of [...all].sort()) {
    const supportedBy: string[] = [];
    const missingFrom: string[] = [];
    for (const p of profiles) {
      (p.features.has(feature) ? supportedBy : missingFrom).push(p.profile.fingerprint);
    }
    if (missingFrom.length === 0) shared.push(feature);
    else features.push({ feature, supportedBy, missingFrom });
  }

  return { features, sharedFeatures: shared };
}

// ── Formats ─────────────────────────────────────────────

function diffFormats(profiles: Indexed[]): FormatDiff[] {
  const all = new Set<string>();
  for (const p of profiles) {
    for (const format of p.formats.keys()) all.add(format);
  }

  const out: FormatDiff[] = [];

  for (const format of [...all].sort()) {
    for (const capability of CAPABILITIES) {
      const supportedBy: string[] = [];
      const missingFrom: string[] = [];

      for (const p of profiles) {
        const entry = p.formats.get(format);
        // A format the probe never checked is not evidence of anything.
        if (!entry) continue;
        (entry[capability] ? supportedBy : missingFrom).push(p.profile.fingerprint);
      }

      // Only differences are interesting; uniform support is the common case.
      if (supportedBy.length > 0 && missingFrom.length > 0) {
        out.push({ format, capability, supportedBy, missingFrom });
      }
    }
  }

  return out;
}

// ── Limits ──────────────────────────────────────────────

function diffLimits(profiles: Indexed[]): LimitDiff[] {
  const all = new Set<string>();
  for (const p of profiles) for (const limit of p.limits.keys()) all.add(limit);

  const out: LimitDiff[] = [];

  for (const limit of [...all].sort()) {
    const values: Record<string, number> = {};
    for (const p of profiles) {
      const entry = p.limits.get(limit);
      if (entry) values[p.profile.fingerprint] = entry.achieved;
    }

    const nums = Object.values(values);
    if (nums.length < 2) continue;

    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min === max) continue;

    out.push({ limit, values, min, max, ratio: min > 0 ? max / min : Infinity });
  }

  // Widest gaps first — those are the ones that break portability.
  return out.sort((a, b) => b.ratio - a.ratio);
}

// ── Benchmarks ──────────────────────────────────────────

function diffBenchmarks(profiles: Indexed[]): BenchDiff[] {
  const all = new Map<string, BenchResult>();
  for (const p of profiles) {
    for (const [id, r] of p.benchmarks) {
      if (!all.has(id)) all.set(id, r);
    }
  }

  const out: BenchDiff[] = [];

  for (const [id, sample] of all) {
    const values: Record<string, number | null> = {};
    const unreliable: string[] = [];

    for (const p of profiles) {
      const fp = p.profile.fingerprint;
      const r = p.benchmarks.get(id);
      if (!r || r.failed || r.throughput == null) {
        values[fp] = null;
        continue;
      }
      values[fp] = r.throughput;

      // An older profile has no quantization data at all, so its numbers cannot
      // be vouched for — silence there means "not recorded", not "fine".
      const stale = (p.profile.schema ?? 0) < MIN_COMPARABLE_BENCHMARK_SCHEMA;
      if (stale || r.quantized || r.variation > UNSTABLE_ABOVE) unreliable.push(fp);
    }

    const present = Object.entries(values)
      .filter((e): e is [string, number] => e[1] != null);

    let fastest: string | null = null;
    let slowest: string | null = null;
    let ratio: number | null = null;

    if (present.length >= 2) {
      const sorted = [...present].sort((a, b) => b[1] - a[1]);
      fastest = sorted[0][0];
      slowest = sorted[sorted.length - 1][0];
      const hi = sorted[0][1];
      const lo = sorted[sorted.length - 1][1];
      ratio = lo > 0 ? hi / lo : null;
    }

    out.push({
      id,
      description: sample.description,
      unit: sample.throughputUnit ?? '',
      values,
      fastest,
      slowest,
      ratio,
      unreliable,
    });
  }

  // Biggest performance gaps first — that is where the portability risk is.
  return out.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0));
}

// ── Rendering ───────────────────────────────────────────

export interface FormatOptions {
  /**
   * Rows to print per section before summarising the rest. Sections are sorted
   * worst-first, so the truncated tail is the least interesting part — but a
   * hundred devices would otherwise produce thousands of lines.
   */
  limit?: number;
}

/**
 * Render a comparison as plain text. Useful for dropping into an issue, a
 * README, or a terminal without building a table by hand.
 */
export function formatComparison(c: Comparison, options: FormatOptions = {}): string {
  const limit = Math.max(1, options.limit ?? 20);
  const lines: string[] = [];
  const short = (fp: string) => fp.slice(0, 8);

  const truncate = <T>(items: T[]): { shown: T[]; hidden: number } => ({
    shown: items.slice(0, limit),
    hidden: Math.max(0, items.length - limit),
  });
  const noteHidden = (hidden: number, what: string) => {
    if (hidden > 0) lines.push(`  ... and ${hidden} more ${what}`);
  };

  lines.push('Devices');
  for (const d of c.devices) {
    const flags = [
      d.mobile ? '(mobile)' : '',
      d.staleBenchmarks ? `(schema ${d.schema} - benchmarks not comparable)` : '',
    ].filter(Boolean).join(' ');
    lines.push(`  ${short(d.fingerprint)}  ${d.label}${flags ? '  ' + flags : ''}`);
  }

  if (c.benchmarks.length > 0) {
    lines.push('', 'Performance');
    const { shown: benches, hidden: hiddenBenches } = truncate(c.benchmarks);
    for (const b of benches) {
      const gap = b.ratio ? `${b.ratio.toFixed(1)}x` : '—';
      lines.push(`  ${b.id}  (${b.unit})  gap ${gap}`);
      for (const d of c.devices) {
        const v = b.values[d.fingerprint];
        const flag = b.unreliable.includes(d.fingerprint) ? '  [unreliable]' : '';
        lines.push(`    ${short(d.fingerprint)}  ${v != null ? v.toLocaleString() : '—'}${flag}`);
      }
    }
    noteHidden(hiddenBenches, 'benchmarks');
  }

  if (c.features.length > 0) {
    lines.push('', 'Features not available everywhere');
    const { shown, hidden } = truncate(c.features);
    for (const f of shown) {
      lines.push(`  ${f.feature}  missing on ${f.missingFrom.map(short).join(', ')}`);
    }
    noteHidden(hidden, 'features');
  }

  if (c.formats.length > 0) {
    lines.push('', 'Format capabilities that differ');
    const { shown, hidden } = truncate(c.formats);
    for (const f of shown) {
      lines.push(`  ${f.format}.${f.capability}  missing on ${f.missingFrom.map(short).join(', ')}`);
    }
    noteHidden(hidden, 'format capabilities');
  }

  if (c.limits.length > 0) {
    lines.push('', 'Limits that differ');
    const { shown: limitRows, hidden: hiddenLimits } = truncate(c.limits);
    for (const l of limitRows) {
      const gap = Number.isFinite(l.ratio) ? `${l.ratio.toFixed(1)}x` : '—';
      const vals = c.devices
        .map((d) => `${short(d.fingerprint)}=${l.values[d.fingerprint]?.toLocaleString() ?? '—'}`)
        .join('  ');
      lines.push(`  ${l.limit}  gap ${gap}   ${vals}`);
    }
    noteHidden(hiddenLimits, 'limits');
  }

  if (c.excluded.length > 0) {
    lines.push('', 'Excluded');
    for (const e of c.excluded) lines.push(`  profile #${e.index}: ${e.reason}`);
  }

  return lines.join('\n');
}

function majorVersion(v: string): string {
  return v.split('.')[0] ?? '';
}
