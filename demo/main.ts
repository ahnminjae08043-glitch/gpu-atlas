import { probe, compareProfiles } from '../src/index.js';
import type { AtlasProfile, FormatSupport } from '../src/types.js';
import type { Comparison } from '../src/compare.js';
import { asProfile, parseLoose } from './parse.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const runBtn = $<HTMLButtonElement>('#run');
const quickBtn = $<HTMLButtonElement>('#quick');
const shareBtn = $<HTMLButtonElement>('#share');
const copyBtn = $<HTMLButtonElement>('#copy');
const saveBtn = $<HTMLButtonElement>('#save');
const progress = $<HTMLDivElement>('#progress');
const bar = $<HTMLElement>('#progress .bar > i');
const stage = $<HTMLDivElement>('#progress .stage');
const out = $<HTMLDivElement>('#out');
const filesInput = $<HTMLInputElement>('#files');
const pasteArea = $<HTMLTextAreaElement>('#paste');
const compareBtn = $<HTMLButtonElement>('#compare');
const clearBtn = $<HTMLButtonElement>('#clear-loaded');
const loadedInfo = $<HTMLDivElement>('#loaded');

let current: AtlasProfile | null = null;
/** Profiles loaded from other devices, keyed by fingerprint to avoid duplicates */
const loaded = new Map<string, AtlasProfile>();

runBtn.onclick = () => run(true);
quickBtn.onclick = () => run(false);

copyBtn.onclick = async () => {
  if (!current) return;
  await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy profile'), 1500);
};

// The dataset only grows if sharing is easier than not bothering. Two actions:
// press this, then paste. The JSON is far too large for a prefilled issue body,
// so the clipboard carries it and the form only has to be opened.
const ISSUES = 'https://github.com/ahnminjae08043-glitch/gpu-atlas/issues/new';

shareBtn.onclick = async () => {
  if (!current) return;

  let copied = true;
  try {
    await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
  } catch {
    // Denied, or an insecure context. Still worth opening the form.
    copied = false;
  }

  const { browser, browserVersion, mobile } = current.environment;
  // A probe can finish without an adapter identity — some browsers withhold it.
  const device =
    [current.adapter?.vendor, current.adapter?.architecture].filter(Boolean).join(' ') ||
    'unknown GPU';
  const version = browserVersion.split('.')[0];

  const url = new URL(ISSUES);
  url.searchParams.set('template', 'profile.yml');
  // A labels parameter is ignored once template= is present, and the template
  // can only carry static ones — so the fact worth filtering on goes in the title.
  const kind = mobile ? ' (mobile)' : '';
  url.searchParams.set('title', `Profile: ${browser} ${version} on ${device}${kind}`);
  window.open(url.toString(), '_blank', 'noopener');

  shareBtn.textContent = copied ? 'Copied — now paste' : 'Use Copy profile first';
  setTimeout(() => (shareBtn.textContent = 'Share profile'), 4000);
};

saveBtn.onclick = () => {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `gpu-atlas-${current.fingerprint}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

async function run(benchmark: boolean) {
  runBtn.disabled = quickBtn.disabled = true;
  shareBtn.disabled = copyBtn.disabled = saveBtn.disabled = true;
  progress.classList.add('on');
  out.innerHTML = '';

  try {
    current = await probe({
      benchmark,
      onProgress: (name, ratio) => {
        bar.style.width = `${(ratio * 100).toFixed(1)}%`;
        stage.textContent = `${name} — ${(ratio * 100).toFixed(0)}%`;
      },
    });
    render(current);
    shareBtn.disabled = copyBtn.disabled = saveBtn.disabled = false;
  } catch (e) {
    out.innerHTML = `<section><div class="panel x">The probe crashed: ${esc(String(e))}</div></section>`;
  } finally {
    runBtn.disabled = quickBtn.disabled = false;
    progress.classList.remove('on');
  }
}

filesInput.onchange = async () => {
  const files = [...(filesInput.files ?? [])];
  let added = 0;
  const errors: string[] = [];
  for (const f of files) {
    try {
      added += ingest(JSON.parse(await f.text()));
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  filesInput.value = '';
  reportLoaded(added, errors);
};

clearBtn.onclick = () => {
  loaded.clear();
  pasteArea.value = '';
  reportLoaded(0, []);
};

compareBtn.onclick = () => {
  const errors: string[] = [];
  const text = pasteArea.value.trim();
  if (text) {
    try {
      // Accept a bare object, an array, or several objects pasted back to back.
      for (const obj of parseLoose(text)) ingest(obj);
      pasteArea.value = '';
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  const profiles = [...(current ? [current] : []), ...loaded.values()];
  if (profiles.length < 2) {
    reportLoaded(0, [
      ...errors,
      'need at least two profiles - run the probe on this device and load at least one more',
    ]);
    return;
  }

  reportLoaded(0, errors);
  renderComparison(compareProfiles(profiles));
};

/** Accept a profile-shaped object, returning how many were taken */
function ingest(obj: unknown): number {
  const list = Array.isArray(obj) ? obj : [obj];
  for (const item of list) {
    const p = asProfile(item);
    loaded.set(p.fingerprint, p);
  }
  return list.length;
}

function reportLoaded(added: number, errors: string[]) {
  const names = [...loaded.values()]
    .map((p) => `${p.fingerprint.slice(0, 8)} ${describeLoaded(p)}`);
  const parts: string[] = [];
  parts.push(names.length ? `Loaded: ${names.join(' · ')}` : 'No external profiles loaded.');
  if (added) parts.push(`(+${added})`);
  for (const e of errors) parts.push(`<span class="x">${esc(e)}</span>`);
  loadedInfo.innerHTML = parts.join(' ');
}

function describeLoaded(p: AtlasProfile): string {
  const gpu = [p.adapter?.vendor, p.adapter?.architecture].filter(Boolean).join(' ');
  return esc(`${gpu || 'unknown'} / ${p.environment.browser}`);
}

function renderComparison(c: Comparison) {
  const short = (fp: string) => fp.slice(0, 8);
  const head = c.devices.map((d) =>
    `<th class="num" title="${esc(d.label)}">${short(d.fingerprint)}</th>`).join('');
  const marks = (fps: string[]) => c.devices.map((d) =>
    `<td class="num">${fps.includes(d.fingerprint)
      ? '<span class="y">O</span>' : '<span class="x">·</span>'}</td>`).join('');

  const parts: string[] = [];

  parts.push(section('Compared devices', `<div class="panel"><dl class="kv">
    ${c.devices.map((d) => kvHtml(short(d.fingerprint),
      `${esc(d.label)}${d.mobile ? ' <span class="n">(mobile)</span>' : ''}`
      + `${d.staleBenchmarks ? ` <span class="flag">(schema ${d.schema}, benchmarks not comparable)</span>` : ''}`)).join('')}
  </dl>${c.excluded.length ? `<p class="hint x">${c.excluded.map((e) =>
    esc(`profile #${e.index}: ${e.reason}`)).join('<br>')}</p>` : ''}</div>`));

  if (c.benchmarks.length) {
    parts.push(section('Performance spread', `<div class="panel">
      <table>
        <thead><tr><th>benchmark</th><th>unit</th>${head}<th class="num">gap</th></tr></thead>
        <tbody>${c.benchmarks.map((b) => `<tr>
          <td title="${esc(b.description)}">${esc(b.id)}</td>
          <td><span class="n">${esc(b.unit)}</span></td>
          ${c.devices.map((d) => {
            const v = b.values[d.fingerprint];
            const flag = b.unreliable.includes(d.fingerprint)
              ? '<span class="flag" title="quantized or unstable measurement">*</span>' : '';
            return `<td class="num">${v != null ? v.toLocaleString() : '—'}${flag}</td>`;
          }).join('')}
          <td class="num gap">${b.ratio ? `${b.ratio.toFixed(1)}x` : '—'}</td>
        </tr>`).join('')}</tbody>
      </table>
      ${c.benchmarks.some((b) => b.unreliable.length)
        ? '<p class="hint">* measurement sat on the quantization floor or was unstable, so a gap involving it is not reliable</p>'
        : ''}
    </div>`));
  }

  parts.push(section(`Features — ${c.sharedFeatures.length} shared, ${c.features.length} uneven`,
    c.features.length === 0
      ? '<div class="panel empty">Every compared device declares the same features.</div>'
      : `<div class="panel"><table>
          <thead><tr><th>feature</th>${head}</tr></thead>
          <tbody>${c.features.map((f) => `<tr>
            <td>${esc(f.feature)}</td>${marks(f.supportedBy)}
          </tr>`).join('')}</tbody>
        </table></div>`));

  parts.push(section(`Format capabilities that differ — ${c.formats.length}`,
    c.formats.length === 0
      ? '<div class="panel empty">Every format behaves identically across these devices.</div>'
      : `<div class="panel"><table>
          <thead><tr><th>format</th><th>capability</th>${head}</tr></thead>
          <tbody>${c.formats.map((f) => `<tr>
            <td>${esc(f.format)}</td>
            <td><span class="n">${esc(f.capability)}</span></td>${marks(f.supportedBy)}
          </tr>`).join('')}</tbody>
        </table></div>`));

  parts.push(section(`Limits that differ — ${c.limits.length}`,
    c.limits.length === 0
      ? '<div class="panel empty">Every measured limit matches across these devices.</div>'
      : `<div class="panel"><table>
          <thead><tr><th>limit</th>${head}<th class="num">gap</th></tr></thead>
          <tbody>${c.limits.map((l) => `<tr>
            <td>${esc(l.limit)}</td>
            ${c.devices.map((d) => {
              const v = l.values[d.fingerprint];
              return `<td class="num">${v != null ? bytes(l.limit, v) : '—'}</td>`;
            }).join('')}
            <td class="num gap">${Number.isFinite(l.ratio) ? `${l.ratio.toFixed(1)}x` : '—'}</td>
          </tr>`).join('')}</tbody>
        </table></div>`));

  out.innerHTML = parts.join('');
  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function render(p: AtlasProfile) {
  const parts: string[] = [];

  if (p.unavailable) {
    parts.push(section('WebGPU unavailable', `<div class="panel x">${esc(p.unavailable)}</div>`));
    out.innerHTML = parts.join('');
    return;
  }

  const breaking = p.discrepancies.filter((d) => d.severity === 'breaking').length;
  const degraded = p.discrepancies.filter((d) => d.severity === 'degraded').length;
  const notes = p.discrepancies.filter((d) => d.severity === 'note').length;

  parts.push(section('Adapter', `<div class="panel"><dl class="kv">
    ${kv('vendor', p.adapter?.vendor || '(not exposed)')}
    ${kv('architecture', p.adapter?.architecture || '(not exposed)')}
    ${kv('device', p.adapter?.device || '(not exposed)')}
    ${kv('description', p.adapter?.description || '(not exposed)')}
    ${kvHtml('fallback adapter', p.adapter?.isFallbackAdapter
      ? '<span class="x">yes — software rendering</span>' : 'no')}
    ${kv('browser', `${p.environment.browser} ${p.environment.browserVersion}`)}
    ${kv('platform', p.environment.platform ?? '(unknown)')}
    ${kv('mobile', p.environment.mobile ? 'yes' : 'no')}
    ${kv('preferredCanvasFormat', p.declared?.preferredCanvasFormat ?? '')}
    ${kv('fingerprint', p.fingerprint)}
    ${kv('probe duration', `${p.elapsedMs}ms`)}
  </dl></div>`));

  const issueHtml = p.discrepancies.length === 0
    ? '<div class="panel empty">Nothing diverged. This device behaves exactly as it declares.</div>'
    : `<div class="panel">${p.discrepancies.map((d) => `
        <div class="issue ${d.severity}">
          <b>${esc(d.subject)}</b> <span>${esc(d.kind)}</span><br>${esc(d.detail)}
        </div>`).join('')}</div>`;
  parts.push(section(
    `Discrepancies — ${breaking} breaking · ${degraded} degraded · ${notes} notes`,
    issueHtml,
  ));

  const formats = p.verified?.formats ?? [];
  parts.push(section(`${formats.length} formats verified`, `<div class="panel">
    <table>
      <thead><tr>
        <th>format</th><th>create</th><th>sample</th><th>render</th>
        <th>blend</th><th>storage</th><th>MSAA4x</th><th>feature</th>
      </tr></thead>
      <tbody>${formats.map(formatRow).join('')}</tbody>
    </table></div>`));

  const shaders = p.verified?.shaders ?? [];
  parts.push(section('WGSL compilation', `<div class="panel">
    <table>
      <thead><tr><th>case</th><th>compile</th><th>pipeline</th><th class="num">time</th><th>note</th></tr></thead>
      <tbody>${shaders.map((s) => {
        const note = s.messages.find((m) => m.type === 'error')?.message
          ?? (s.skipped ? s.messages[0]?.message : '') ?? '';
        return `<tr>
          <td title="${esc(s.description)}">${esc(s.id)}</td>
          <td>${s.skipped ? '<span class="n">skipped</span>' : mark(s.compiled)}</td>
          <td>${s.skipped ? '<span class="n">—</span>' : mark(s.pipelineCreated)}</td>
          <td class="num">${s.compileMs ? `${s.compileMs.toFixed(1)}ms` : '—'}</td>
          <td><span class="n">${esc(note.slice(0, 90))}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`));

  const limits = p.verified?.limits ?? [];
  parts.push(section('Limits verified', `<div class="panel">
    <table>
      <thead><tr><th>limit</th><th class="num">declared</th><th class="num">achieved</th><th>result</th></tr></thead>
      <tbody>${limits.map((l) => `<tr>
        <td>${esc(l.limit)}</td>
        <td class="num">${bytes(l.limit, l.declared)}</td>
        <td class="num">${bytes(l.limit, l.achieved)}</td>
        <td>${l.honored ? '<span class="y">honored</span>' : '<span class="x">refused</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`));

  if (p.benchmarks) {
    const b = p.benchmarks;
    parts.push(section(
      `Benchmarks — ${b.timestampQuery ? 'GPU timestamps' : 'wall clock'}` +
      `${b.timerResolutionNs ? `, GPU timer ${(b.timerResolutionNs / 1000).toFixed(1)}µs` : ', GPU timer continuous'}` +
      `${b.wallClockResolutionMs ? `, wall clock ${b.wallClockResolutionMs.toFixed(3)}ms` : ''}` +
      `, ${Math.round(b.totalMs)}ms total`,
      `<div class="panel">
      <table>
        <thead><tr><th>benchmark</th><th class="num">median</th><th class="num">min</th><th class="num">throughput</th><th class="num">reps</th><th class="num">ticks</th><th class="num">variation</th><th>clock</th></tr></thead>
        <tbody>${b.results.map((r) => `<tr>
          <td title="${esc(r.description)}">${esc(r.id)}</td>
          <td class="num">${r.failed ? '—' : `${r.medianMs.toFixed(2)}ms`}</td>
          <td class="num">${r.failed ? '—' : `${r.minMs.toFixed(2)}ms`}</td>
          <td class="num">${r.throughput != null ? `${r.throughput.toLocaleString()} ${esc(r.throughputUnit ?? '')}` : '—'}</td>
          <td class="num">${r.repetitions || '—'}</td>
          <td class="num ${r.quantized ? 'shaky' : ''}" title="${r.quantized ? 'on the quantization floor — throughput is a lower bound' : ''}">${r.ticks != null ? r.ticks.toLocaleString() : '—'}</td>
          <td class="num ${r.variation > 0.2 ? 'shaky' : ''}">${r.failed ? '—' : `${(r.variation * 100).toFixed(0)}%`}</td>
          <td><span class="n">${r.failed ? esc(r.failed.slice(0, 40)) : (r.timing === 'timestamp-query' ? 'GPU' : 'wall')}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`));
  }

  parts.push(section('Profile JSON', `<pre>${esc(JSON.stringify(p, null, 2))}</pre>`));

  out.innerHTML = parts.join('');
}

function formatRow(f: FormatSupport): string {
  const feature = f.requiresFeature
    ? `<span class="${f.featureDeclared ? 'y' : 'n'}">${esc(f.requiresFeature)}</span>`
    : '<span class="n">core</span>';
  return `<tr>
    <td>${esc(f.format)}</td>
    <td>${mark(f.creatable)}</td>
    <td>${mark(f.sampleable)}</td>
    <td>${mark(f.renderable)}</td>
    <td>${mark(f.blendable)}</td>
    <td>${mark(f.storageWritable)}</td>
    <td>${mark(f.multisample4x)}</td>
    <td>${feature}</td>
  </tr>`;
}

const mark = (v: boolean) => (v ? '<span class="y">O</span>' : '<span class="n">·</span>');

function bytes(limit: string, n: number): string {
  if (!/Size$/.test(limit)) return n.toLocaleString();
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return String(n);
}

const section = (title: string, body: string) =>
  `<section><h2>${esc(title)}</h2>${body}</section>`;

/**
 * Escapes by default. Profile fields can come from an uploaded file, so a
 * helper that trusts its input is a trap sitting next to untrusted data.
 */
const kv = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;

/** For the few rows that intentionally carry markup */
const kvHtml = (k: string, html: string) => `<dt>${esc(k)}</dt><dd>${html}</dd>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
