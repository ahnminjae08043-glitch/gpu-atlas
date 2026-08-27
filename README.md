# gpu-atlas

**What WebGPU actually does on a device — measured, not declared.**

**[Run it on your device →](https://ahnminjae08043-glitch.github.io/gpu-atlas/)**
Takes a few seconds. Nothing is uploaded; the profile stays in your browser
unless you save it yourself.

---

## What measuring turned up

Two devices, profiled the same way. Desktop is an NVIDIA Lovelace GPU on Chrome
151; mobile is a Qualcomm Adreno 7xx on Samsung Internet 30.

### Performance does not scale by a single factor

| benchmark | desktop | mobile | gap |
|---|---:|---:|---:|
| triangle throughput | 3,795 MTri/s | 65 MTri/s | **58x** |
| texture sampling | 241 GSample/s | 11 GSample/s | 22x |
| fill rate | 130,977 MPixel/s | 6,982 MPixel/s | 19x |
| bind group switching | 3,884,892 /s | 217,391 /s | 18x |
| fragment ALU | 2,994 MPixel/s | 180 MPixel/s | 17x |
| draw call overhead | 9,105,691 /s | 736,196 /s | 12x |
| pipeline switching | 1,621,622 /s | 162,602 /s | 10x |

Geometry is roughly five times worse off than everything else. On a tile-based
mobile GPU the binning cost lands on vertices, so the practical conclusion is
that **cutting triangles buys far more than cutting pixels** — the opposite of
the usual desktop instinct. A single composite score would have averaged this
into "mobile is ~20x slower" and thrown away the one number worth acting on.

### Capability differences that break code

- `bgra8unorm` is storage-writable on desktop and not on mobile. Since
  `bgra8unorm` is also desktop's `preferredCanvasFormat` (mobile reports
  `rgba8unorm`), this is an easy way to ship something that works locally and
  fails on phones.
- `maxStorageBufferBindingSize` is **16x** apart: 2GB vs 128MB.
- Compression support is disjoint. Desktop has BC only; mobile has BC **and**
  ETC2 **and** ASTC. Shipping one compressed format for everyone does not work.
- `float32-filterable` is desktop-only here.

### Browsers quantize GPU timestamps to exactly 2^16 ns

`timestamp-query` results are rounded into buckets as a Spectre mitigation.
Measured directly, the bucket is **65,536 ns** — and it came back identical on
both machines despite different GPU vendors, operating systems, and browsers.
That points at a Chromium policy rather than anything about the hardware.

The practical consequence for anyone writing WebGPU benchmarks: **work shorter
than ~65 microseconds cannot be measured at all.** It reports as zero, or as a
number indistinguishable from unrelated work. Before this was accounted for,
two unrelated benchmarks here reported byte-identical timings, and geometry
throughput was being understated by 13%.

---

## Usage

```bash
npm install gpu-atlas
```

```js
import { probe, breakingIssues, pickFormat } from 'gpu-atlas';

const profile = await probe();

// Anything that will break on this device
for (const issue of breakingIssues(profile)) {
  console.warn(issue.subject, issue.detail);
}

// Pick a format verified to work here, rather than one merely declared
const hdr = pickFormat(profile, ['rgba16float', 'rgb10a2unorm', 'rgba8unorm'], 'render');
```

Comparing devices:

```js
import { compareProfiles, formatComparison } from 'gpu-atlas';

const comparison = compareProfiles([desktopProfile, mobileProfile]);
console.log(formatComparison(comparison));

// Benchmarks are sorted by gap, so the worst portability risk comes first
const worst = comparison.benchmarks[0];
console.log(worst.id, worst.ratio);   // "triangle-throughput", 58.3
```

Measurements flagged `unreliable` — quantized or unstable — are marked rather
than silently folded into the comparison.

## What it measures

**Texture formats.** 53 formats, each checked for six separate capabilities:
creation, shader sampling, render target, blending, storage binding, and 4x
MSAA. A format that creates fine but fails to bind is a real failure mode and it
is invisible in the feature list.

**WGSL compilation.** Cases chosen where implementations diverge: function
pointers, dynamic uniform indexing, struct alignment, override constants,
workgroup atomics, uniformity analysis. Chrome uses Dawn/Tint, Firefox uses
wgpu/naga, Safari has its own compiler, and each targets a different backend
language. Compile time is recorded too, since it drives first-frame stalls.

**Limits.** Declared values are requested for real, then bisected to find the
actual ceiling when a device refuses.

**Benchmarks.** Separated by axis rather than collapsed into a score, for the
reason the table above demonstrates.

## Measurement notes

Getting numbers is easy; getting numbers that mean anything was most of the work.

**Quantization is measured, not assumed.** Work below one bucket reports as
zero, so a trivial workload is grown until readings become non-zero. The
smallest positive reading bounds the bucket, and the smallest gap between
distinct readings lands on it. Each benchmark then scales its repetitions until
it spans at least 100 buckets, and every result carries its `ticks` count.

**This is the only way to read a variation of zero correctly.** Perfect
consistency and a timer that cannot resolve the work look identical otherwise.
Mobile turned out to be genuinely more reproducible than desktop here — three
benchmarks repeated to the decimal place across independent runs, while desktop
drifted several percent — but that only became a claim worth making once ticks
confirmed the measurements were not sitting on the floor.

**Draw call cost is not GPU time.** It lives in browser validation and driver
calls, which barely register on GPU timestamps. Those benchmarks are wall-clock
by design, and each result records which clock produced it.

## Feature-aware baselines

WebGPU widens core capabilities through features — `texture-formats-tier1` adds
storage binding to a set of formats, `float32-blendable` adds blending to 32-bit
float targets. Comparing against a fixed core baseline produces a flood of false
"more permissive than spec" reports, so the baseline is raised to match what a
device declares before comparing. What survives is genuine divergence.

## The profile

`probe()` returns a JSON-serializable `AtlasProfile` keeping `declared` and
`verified` strictly separate, plus a `discrepancies` list where they disagree:

- `breaking` — code relying on the declared value will fail here
- `degraded` — it works, but slower or with reduced capability
- `note` — worth recording, not worth acting on

## Status

Early, and honest about it. **Two devices is not a dataset.** The capability
differences above are facts about these two machines; whether they generalize
needs many more profiles.

Worth noting that the original premise — that browsers misreport their own
capabilities — has not held up. Both devices did exactly what they declared,
zero discrepancies each. The value turned out to be in the gaps *between*
devices instead, which is why comparison exists at all.

If you run the probe, saving the JSON and opening an issue with it genuinely
helps. Mobile GPUs, Firefox, and Safari are the biggest blind spots.

## License

MIT
