# gpu-atlas

**What WebGPU actually does on a device — measured, not declared.**

**[Run it on your device →](https://ahnminjae08043-glitch.github.io/gpu-atlas/)**
Takes a few seconds. Nothing is uploaded; the profile stays in your browser
unless you save it yourself.

---

## What measuring three devices turned up

| | desktop | laptop | phone |
|---|---|---|---|
| GPU | NVIDIA Lovelace | Apple silicon | Adreno 7xx |
| browser | Chrome 151 | Safari 26 | Samsung Internet 30 |

### Performance does not scale by a single factor

| benchmark | desktop | Apple | Adreno | spread |
|---|---:|---:|---:|---:|
| triangle throughput | 3,906 MTri/s | 354 | 65 | **60x** |
| texture sampling | 238 GSample/s | 18.4 | 11.0 | 22x |
| fill rate | 124,464 MPixel/s | 35,079 | 6,522 | 19x |
| bind group switching | 3,913,043 /s | 909,091 | 217,391 | 18x |
| fragment ALU | 2,994 MPixel/s | 267 | 179 | 17x |
| draw call overhead | 9,896,907 /s | 1,818,182 | 952,381 | 10x |
| pipeline switching | 1,698,113 /s | 1,363,636 | 203,046 | 8x |

Geometry spreads three times wider than anything else, and the ordering is not
uniform either. Against Apple silicon the desktop's geometry lead (11x) is
ordinary and its texture sampling lead (13x) is the largest; against Adreno,
geometry is the worst axis by a distance. Tile-based mobile GPUs pay binning
cost on vertices, so **on phones, cutting triangles buys far more than cutting
pixels** — the reverse of the desktop instinct.

Pipeline switching is the flattest axis of all: Apple silicon is within 1.2x of
a desktop discrete GPU there while being 11x behind on geometry. Any single
"this device is N times slower" number would be wrong in both directions at
once.

### Capability differences that break code

**`maxUniformBufferBindingSize` differs by 10,922x.** Safari allows 683MB;
Chrome and Samsung Internet cap at 64KB. Code developed on a Mac against large
uniform buffers does not merely run slower elsewhere — it fails outright.

**No compressed texture format works everywhere.** Desktop Chrome has BC only.
Safari has ETC2 and ASTC but no BC. Adreno has all three. Desktop Chrome and
Safari — both desktops — share *zero* compressed formats.

**`bgra8unorm` is storage-writable on desktop and on Apple, but not on Adreno.**
It is also the preferred canvas format on two of the three (the phone reports
`rgba8unorm`), which makes it an easy thing to build on and have fail on phones.

`maxStorageBufferBindingSize` spans 16x (2GB / 683MB / 128MB).

### Browsers quantize GPU timestamps, and by different amounts

`timestamp-query` results are rounded into buckets as a Spectre mitigation.
Measured rather than assumed:

| | GPU timer | `performance.now()` |
|---|---|---|
| Chrome 151 | 65,536 ns (2^16) | 0.1 ms |
| Samsung Internet 30 | 65,536 ns (2^16) | 0.1 ms |
| Safari 26 | no quantization detected | 1 ms |

Both Chromium browsers return exactly 2^16 despite different GPU vendors and
operating systems, while WebKit does not quantize the GPU timer at all — this is
browser policy, not hardware.

The practical consequence: **on Chromium, GPU work shorter than ~65 microseconds
cannot be measured.** It reports as zero or as a value indistinguishable from
unrelated work. Before accounting for this, two unrelated benchmarks here
reported byte-identical timings.

### A benchmark that measured nothing

Fragment work was originally created by stacking identical opaque fullscreen
draws. On Apple silicon that reported 112,524 MPixel/s — a 37x *advantage* over
an RTX 4060, which is not plausible. A tile-based deferred renderer discards
occluded opaque fragments before shading them, so every draw but the last was
being thrown away. Adreno, tile-based but not deferred to the same degree, did
not do this, so the same benchmark id was measuring different work per
architecture.

Additive blending fixes it, since each draw must contribute to the accumulated
result. The corrected figure is 267 MPixel/s — **530x lower**, and consistent
with a laptop GPU. Geometry throughput was unaffected, as its triangles occupy
distinct screen positions and never occluded one another.

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

Comparing devices — this needs no GPU, so it also works in Node:

```js
import { compareProfiles, formatComparison } from 'gpu-atlas';

const comparison = compareProfiles([desktop, laptop, phone]);
console.log(formatComparison(comparison));

// Sorted by spread, so the worst portability risk is first
const worst = comparison.benchmarks[0];
console.log(worst.id, worst.ratio);   // "triangle-throughput", 60.0
```

Measurements flagged `unreliable` — quantized or unstable — are marked rather
than folded silently into a ratio.

## What it measures

**Texture formats.** 53 formats, each checked for six separate capabilities:
creation, shader sampling, render target, blending, storage binding, and 4x
MSAA. A format that creates fine but fails to bind is a real failure mode, and
it is invisible in the feature list.

**WGSL compilation.** Cases where implementations diverge: function pointers,
dynamic uniform indexing, struct alignment, override constants, workgroup
atomics, uniformity analysis. Chrome uses Dawn/Tint, Firefox uses wgpu/naga,
Safari has its own compiler, and each targets a different backend language.
Compile time is recorded too, since it drives first-frame stalls.

**Limits.** Declared values are requested for real, then bisected to find the
actual ceiling when a device refuses.

**Benchmarks.** Separated by axis rather than collapsed into a score, for the
reason the table above demonstrates.

## Measurement notes

Getting numbers is easy; getting numbers that mean anything was most of the work.

**Quantization is measured, not assumed** — and validated before it is believed.
Work below one bucket reports as zero, so a trivial workload is grown until
readings become non-zero. The smallest positive reading bounds the bucket, and
the smallest gap between distinct readings lands on it. That candidate then has
to *behave* like a bucket: under real quantization every reading is a multiple
of it. Without that check, a fine-grained timer looks identical to a quantized
one, and the same Safari machine reported a different timer on consecutive runs.

**Both clocks are measured.** `performance.now()` is quantized too, to a full
millisecond in Safari, and the draw-call benchmarks are wall-clock by necessity
— their cost lives in browser validation and driver calls, which barely register
on GPU timestamps. Each benchmark scales its repetitions until it spans enough
ticks of whichever clock timed it, and every result carries that tick count.

**This is the only way to read a variation of zero correctly.** Perfect
consistency and a timer that cannot resolve the work look identical otherwise.
Mobile turned out to be genuinely more reproducible than desktop — geometry
throughput repeated at exactly 65.1 MTri/s across runs weeks apart — but that
only became a claim worth making once ticks confirmed the measurement was not
sitting on the floor.

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

## Profile schema

Profiles are the point of this project, so a profile states which schema it was
captured under and `SCHEMA_VERSION` is bumped whenever a field is added,
removed, or changes meaning. The history is kept in `src/types.ts`.

Version 2 made measurement trustworthiness explicit — tick counts, quantization
flags, measured timer resolutions — and changed the overdraw benchmarks to blend
additively. Version 3 made errors structured rather than preformatted strings,
and widened the fingerprint from 32 bits to 128, since the narrow version
collided at a rate that mattered once profiles were being collected in bulk.

`compareProfiles` accepts older profiles and still compares their capability
data, but marks pre-v2 benchmark numbers `staleBenchmarks` and treats them as
unreliable, because a version 1 profile's silence about quantization means
"not recorded" rather than "fine".

## Contributing

```bash
npm install
npm test        # comparison and quantization detection, no GPU needed
npm run dev     # demo at /demo/
```

The probe needs a real GPU, so it is verified by running the demo on actual
devices. Everything that does not — profile comparison, quantization detection,
discrepancy analysis, fingerprinting — is unit tested and runs in CI.

Automating the probe itself was attempted and does not currently work:
Playwright's bundled Chromium ships without WebGPU, and driving a system Chrome
through it leaves `navigator.gpu` undefined regardless of `--enable-unsafe-swiftshader`,
`--use-angle=swiftshader`, or headed mode. Deno's built-in WebGPU looks like the
more promising route for anyone who wants to try again.

## Status

Early, and honest about it. **Three devices is not a dataset.** The differences
above are facts about these three machines; whether they generalize needs many
more profiles. Firefox and iOS are entirely unmeasured.

Worth stating plainly: the original premise — that browsers misreport their own
capabilities — has not held up. All three devices did exactly what they
declared, zero discrepancies each. The value turned out to be in the gaps
*between* devices, which is why comparison exists at all.

If you run the probe, saving the JSON and opening an issue with it genuinely
helps.

## License

MIT
