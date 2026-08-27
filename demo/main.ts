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
  copyBtn.textContent = '복사됨';
  setTimeout(() => (copyBtn.textContent = '프로파일 복사'), 1500);
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
    out.innerHTML = `<section><div class="panel x">프로브가 죽었다: ${esc(String(e))}</div></section>`;
  } finally {
    runBtn.disabled = quickBtn.disabled = false;
    progress.classList.remove('on');
  }
}

function render(p: AtlasProfile) {
  const parts: string[] = [];

  if (p.unavailable) {
    parts.push(section('WebGPU 사용 불가', `<div class="panel x">${esc(p.unavailable)}</div>`));
    out.innerHTML = parts.join('');
    return;
  }

  // ── 요약 ──
  const breaking = p.discrepancies.filter((d) => d.severity === 'breaking').length;
  const degraded = p.discrepancies.filter((d) => d.severity === 'degraded').length;
  const notes = p.discrepancies.filter((d) => d.severity === 'note').length;

  parts.push(section('어댑터', `<div class="panel"><dl class="kv">
    ${kv('vendor', p.adapter?.vendor || '(비공개)')}
    ${kv('architecture', p.adapter?.architecture || '(비공개)')}
    ${kv('device', p.adapter?.device || '(비공개)')}
    ${kv('description', p.adapter?.description || '(비공개)')}
    ${kv('폴백 어댑터', p.adapter?.isFallbackAdapter ? '<span class="x">그렇다 — 소프트웨어 렌더링</span>' : '아니다')}
    ${kv('브라우저', `${esc(p.environment.browser)} ${esc(p.environment.browserVersion)}`)}
    ${kv('플랫폼', esc(p.environment.platform ?? '(모름)'))}
    ${kv('모바일', p.environment.mobile ? '그렇다' : '아니다')}
    ${kv('preferredCanvasFormat', esc(p.declared?.preferredCanvasFormat ?? ''))}
    ${kv('fingerprint', p.fingerprint)}
    ${kv('측정 시간', `${p.elapsedMs}ms`)}
  </dl></div>`));

  // ── 불일치 ──
  const issueHtml = p.discrepancies.length === 0
    ? '<div class="panel empty">선언과 실측이 어긋난 지점이 없다. 이 기기는 신고한 대로 동작한다.</div>'
    : `<div class="panel">${p.discrepancies.map((d) => `
        <div class="issue ${d.severity}">
          <b>${esc(d.subject)}</b> <span>${esc(d.kind)}</span><br>${esc(d.detail)}
        </div>`).join('')}</div>`;
  parts.push(section(
    `불일치 — 치명 ${breaking} · 성능저하 ${degraded} · 참고 ${notes}`,
    issueHtml,
  ));

  // ── 포맷 ──
  const formats = p.verified?.formats ?? [];
  parts.push(section(`포맷 ${formats.length}종 실검증`, `<div class="panel">
    <table>
      <thead><tr>
        <th>포맷</th><th>생성</th><th>샘플</th><th>렌더</th>
        <th>블렌드</th><th>스토리지</th><th>MSAA4x</th><th>feature</th>
      </tr></thead>
      <tbody>${formats.map(formatRow).join('')}</tbody>
    </table></div>`));

  // ── 셰이더 ──
  const shaders = p.verified?.shaders ?? [];
  parts.push(section('WGSL 컴파일', `<div class="panel">
    <table>
      <thead><tr><th>케이스</th><th>컴파일</th><th>파이프라인</th><th class="num">시간</th><th>비고</th></tr></thead>
      <tbody>${shaders.map((s) => {
        const skipped = s.messages.some((m) => m.type === 'info');
        const note = s.messages.find((m) => m.type === 'error')?.message
          ?? (skipped ? s.messages[0]?.message : '') ?? '';
        return `<tr>
          <td title="${esc(s.description)}">${esc(s.id)}</td>
          <td>${skipped ? '<span class="n">건너뜀</span>' : mark(s.compiled)}</td>
          <td>${skipped ? '<span class="n">—</span>' : mark(s.pipelineCreated)}</td>
          <td class="num">${s.compileMs ? `${s.compileMs.toFixed(1)}ms` : '—'}</td>
          <td><span class="n">${esc(note.slice(0, 90))}</span></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`));

  // ── limits ──
  const limits = p.verified?.limits ?? [];
  parts.push(section('limit 실검증', `<div class="panel">
    <table>
      <thead><tr><th>limit</th><th class="num">선언</th><th class="num">실제</th><th>결과</th></tr></thead>
      <tbody>${limits.map((l) => `<tr>
        <td>${esc(l.limit)}</td>
        <td class="num">${bytes(l.limit, l.declared)}</td>
        <td class="num">${bytes(l.limit, l.achieved)}</td>
        <td>${l.honored ? '<span class="y">지켜짐</span>' : '<span class="x">거절됨</span>'}</td>
      </tr>`).join('')}</tbody>
    </table></div>`));

  // ── 벤치 ──
  if (p.benchmarks) {
    const b = p.benchmarks;
    parts.push(section(
      `벤치마크 — ${b.timestampQuery ? 'GPU 타임스탬프' : '벽시계'} 기준, ${Math.round(b.totalMs)}ms 소요`,
      `<div class="panel">
      <table>
        <thead><tr><th>항목</th><th class="num">중앙값</th><th class="num">최소</th><th class="num">처리량</th><th class="num">변동</th><th>측정</th></tr></thead>
        <tbody>${b.results.map((r) => `<tr>
          <td title="${esc(r.description)}">${esc(r.id)}</td>
          <td class="num">${r.failed ? '—' : `${r.medianMs.toFixed(2)}ms`}</td>
          <td class="num">${r.failed ? '—' : `${r.minMs.toFixed(2)}ms`}</td>
          <td class="num">${r.throughput != null ? `${r.throughput.toLocaleString()} ${esc(r.throughputUnit ?? '')}` : '—'}</td>
          <td class="num ${r.variation > 0.2 ? 'shaky' : ''}">${r.failed ? '—' : `${(r.variation * 100).toFixed(0)}%`}</td>
          <td><span class="n">${r.failed ? esc(r.failed.slice(0, 40)) : (r.timing === 'timestamp-query' ? 'GPU' : '벽시계')}</span></td>
        </tr>`).join('')}</tbody>
      </table></div>`));
  }

  // ── 원본 ──
  parts.push(section('프로파일 JSON', `<pre>${esc(JSON.stringify(p, null, 2))}</pre>`));

  out.innerHTML = parts.join('');
}

function formatRow(f: FormatSupport): string {
  const feature = f.requiresFeature
    ? `<span class="${f.featureDeclared ? 'y' : 'n'}">${esc(f.requiresFeature)}</span>`
    : '<span class="n">코어</span>';
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

const kv = (k: string, v: string) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
