# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: probe.spec.ts >> core WGSL cases compile and build pipelines
- Location: e2e\probe.spec.ts:52:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('#out pre')
Expected: visible
Timeout: 110000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 110000ms
  - waiting for locator('#out pre')

```

```yaml
- main:
  - heading "gpu-atlas" [level=1]
  - paragraph: What WebGPU actually does in this browser — measured by creating the resources and running the passes, not by reading the declared limits.
  - button "Run full probe"
  - button "Skip benchmarks"
  - button "Copy profile"
  - button "Save JSON"
  - group: Compare with profiles from other devices
  - heading "WebGPU unavailable" [level=2]
  - text: requestAdapter returned null — the WebGPU API exists but no usable adapter does
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import type { AtlasProfile } from '../src/types.js';
  3   | import { SCHEMA_VERSION } from '../src/types.js';
  4   | 
  5   | // These run against SwiftShader, so every performance figure here is fiction.
  6   | // What they check is that the probe survives a real WebGPU implementation end
  7   | // to end and emits a profile of the right shape — the ~2000 lines of probe code
  8   | // that pure-function tests cannot touch.
  9   | 
  10  | async function runProbe(page: Page, benchmark: boolean): Promise<AtlasProfile> {
  11  |   await page.goto('/demo/');
  12  |   await page.click(benchmark ? '#run' : '#quick');
> 13  |   await expect(page.locator('#out pre')).toBeVisible({ timeout: 110_000 });
      |                                          ^ Error: expect(locator).toBeVisible() failed
  14  |   return JSON.parse(await page.locator('#out pre').innerText());
  15  | }
  16  | 
  17  | test('probe completes and returns a well-formed profile', async ({ page }) => {
  18  |   const p = await runProbe(page, false);
  19  | 
  20  |   expect(p.unavailable).toBeUndefined();
  21  |   expect(p.schema).toBe(SCHEMA_VERSION);
  22  |   expect(p.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  23  |   expect(p.adapter).not.toBeNull();
  24  |   expect(p.declared!.features).toBeInstanceOf(Array);
  25  |   expect(Object.keys(p.declared!.limits).length).toBeGreaterThan(10);
  26  | });
  27  | 
  28  | test('every format is checked and reports all six capabilities', async ({ page }) => {
  29  |   const p = await runProbe(page, false);
  30  |   const formats = p.verified!.formats;
  31  | 
  32  |   expect(formats.length).toBeGreaterThan(40);
  33  |   for (const f of formats) {
  34  |     for (const key of ['creatable', 'sampleable', 'renderable',
  35  |       'blendable', 'storageWritable', 'multisample4x'] as const) {
  36  |       expect(typeof f[key], `${f.format}.${key}`).toBe('boolean');
  37  |     }
  38  |     // Errors are structured, not preformatted strings.
  39  |     for (const e of f.errors) {
  40  |       expect(typeof e.kind).toBe('string');
  41  |       expect(typeof e.message).toBe('string');
  42  |     }
  43  |   }
  44  | 
  45  |   // Core formats must work anywhere that has WebGPU at all, SwiftShader included.
  46  |   const rgba = formats.find((f) => f.format === 'rgba8unorm')!;
  47  |   expect(rgba.creatable).toBe(true);
  48  |   expect(rgba.sampleable).toBe(true);
  49  |   expect(rgba.renderable).toBe(true);
  50  | });
  51  | 
  52  | test('core WGSL cases compile and build pipelines', async ({ page }) => {
  53  |   const p = await runProbe(page, false);
  54  |   const shaders = p.verified!.shaders;
  55  | 
  56  |   expect(shaders.length).toBeGreaterThan(5);
  57  | 
  58  |   const baseline = shaders.find((s) => s.id === 'baseline')!;
  59  |   expect(baseline.compiled).toBe(true);
  60  |   expect(baseline.pipelineCreated).toBe(true);
  61  | 
  62  |   // A case skipped for a missing feature is not a failure.
  63  |   for (const s of shaders) {
  64  |     if (s.skipped) expect(s.compiled).toBe(false);
  65  |   }
  66  | });
  67  | 
  68  | test('declared limits are actually reachable', async ({ page }) => {
  69  |   const p = await runProbe(page, false);
  70  |   const limits = p.verified!.limits;
  71  | 
  72  |   expect(limits.length).toBeGreaterThan(3);
  73  |   for (const l of limits) {
  74  |     expect(l.achieved).toBeGreaterThan(0);
  75  |     expect(l.achieved).toBeLessThanOrEqual(l.declared);
  76  |     expect(l.honored).toBe(l.achieved === l.declared);
  77  |   }
  78  | });
  79  | 
  80  | test('benchmarks produce coherent measurements', async ({ page }) => {
  81  |   const p = await runProbe(page, true);
  82  |   const b = p.benchmarks!;
  83  | 
  84  |   expect(b.results.length).toBeGreaterThan(3);
  85  | 
  86  |   for (const r of b.results) {
  87  |     if (r.failed) continue;
  88  |     expect(r.medianMs, r.id).toBeGreaterThan(0);
  89  |     expect(r.minMs, r.id).toBeLessThanOrEqual(r.medianMs);
  90  |     expect(r.repetitions, r.id).toBeGreaterThanOrEqual(1);
  91  |     expect(r.samples, r.id).toBeGreaterThan(0);
  92  |     // Auto-scaling exists to push measurements off the quantization floor.
  93  |     if (r.ticks != null) {
  94  |       expect(r.quantized, r.id).toBe(r.ticks < 20);
  95  |     }
  96  |   }
  97  | });
  98  | 
  99  | test('comparing two profiles reports no differences against itself', async ({ page }) => {
  100 |   await page.goto('/demo/');
  101 |   await page.click('#quick');
  102 |   await expect(page.locator('#out pre')).toBeVisible({ timeout: 110_000 });
  103 |   const self = await page.locator('#out pre').innerText();
  104 | 
  105 |   // Loading this device's own profile as the "other" side: same capabilities,
  106 |   // so a correct comparison finds nothing uneven.
  107 |   await page.locator('#compare-box summary').click();
  108 |   await page.locator('#paste').fill(self);
  109 |   await page.click('#compare');
  110 | 
  111 |   await expect(page.locator('#out section').first()).toBeVisible();
  112 |   const text = await page.locator('#out').innerText();
  113 |   expect(text).toContain('Every compared device declares the same features');
```