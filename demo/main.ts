import { probe } from '../src/index.js';
import type { AtlasProfile, FormatSupport } from '../src/types.js';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const runBtn = $<HTMLButtonElement>('#run');
const quickBtn = $<HTMLButtonElement>('#quick');
const copyBtn = $<HTMLButtonElement>('#copy');
const saveBtn = $<HTMLButtonElement>('#save');
const progress = $<HTMLDivElement>('#progress');
const bar = $<HTMLElement>('#progress .bar > i');
const stage = $<HTMLDivElement>('#progress .stage');
const out = $<HTMLDivElement>('#out');

let current: AtlasProfile | null = null;

runBtn.onclick = () => run(true);
quickBtn.onclick = () => run(false);

copyBtn.onclick = async () => {
  if (!current) return;
  await navigator.clipboard.writeText(JSON.stringify(current, null, 2));
  copyBtn.textContent = 'Copied';
  setTimeout(() => (copyBtn.textContent = 'Copy profile'), 1500);
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
  copyBtn.disabled = saveBtn.disabled = true;
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
    copyBtn.disabled = saveBtn.disabled = false;
  } catch (e) {
    out.innerHTML = `<section><div class="panel x">The probe crashed: ${esc(String(e))}</div></section>`;
  } finally {
    runBtn.disabled = quickBtn.disabled = false;
    progress.classList.remove('on');
  }
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
    ${kv('fallback adapter', p.adapter?.isFallbackAdapter ? '<span class="x">yes — software rendering</span>' : 'no')}
    ${kv('browser', `${esc(p.environment.browser)} ${esc(p.environment.browserVersion)}`)}
    ${kv('platform', esc(p.environment.platform ?? '(unknown)'))}
    ${kv('mobile', p.environment.mobile ? 'yes' : 'no')}
    ${kv('preferredCanvasFormat', esc(p.declared?.preferredCanvasFormat ?? ''))}
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
      `Benchmarks — ${b.timestampQuery ? 'GPU timestamps' : 'wall clock'}, ${Math.round(b.totalMs)}ms total`,
      `<div class="panel">
      <table>
        <thead><tr><th>benchmark</th><th class="num">median</th><th class="num">min</th><th class="num">throughput</th><th class="num">reps</th><th class="num">variation</th><th>clock</th></tr></thead>
        <tbody>${b.results.map((r) => `<tr>
          <td title="${esc(r.description)}">${esc(r.id)}</td>
          <td class="num">${r.failed ? '—' : `${r.medianMs.toFixed(2)}ms`}</td>
          <td class="num">${r.failed ? '—' : `${r.minMs.toFixed(2)}ms`}</td>
          <td class="num">${r.throughput != null ? `${r.throughput.toLocaleString()} ${esc(r.throughputUnit ?? '')}` : '—'}</td>
          <td class="num">${r.repetitions || '—'}</td>
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

// Values are pre-escaped or intentional markup by the caller.
const kv = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
