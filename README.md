# gpu-atlas

**What WebGPU actually does on this device — measured, not declared.**

`adapter.limits` says `maxBufferSize` is 2GB. `adapter.features` says
`texture-compression-bc` is supported. Neither statement is a guarantee. Devices
reject allocations they advertise, formats fail to bind in ways the feature list
never hints at, and identical WGSL compiles on one implementation and dies on
another.

gpu-atlas ignores what the browser claims and finds out what it does. Every
capability is verified by actually creating the resource, building the pipeline,
and running the pass.

```bash
npm install gpu-atlas
```

```js
import { probe, breakingIssues, pickFormat } from 'gpu-atlas';

const profile = await probe();

// Things that will break on this device
for (const issue of breakingIssues(profile)) {
  console.warn(issue.subject, issue.detail);
}

// Pick a format that is verified to work — not just declared
const hdr = pickFormat(profile, ['rgba16float', 'rgb10a2unorm', 'rgba8unorm'], 'render');
```

## What it measures

**Texture formats** — 53 formats, each checked for six distinct capabilities:
creation, shader sampling, render target, blending, storage binding, and 4x MSAA.
A format that creates fine but fails to bind is a real and common failure mode,
and it is invisible in the feature list.

**WGSL compilation** — cases chosen where implementations diverge: function
pointers, dynamic uniform indexing, struct alignment, override constants,
workgroup atomics, uniformity analysis. Chrome uses Dawn/Tint, Firefox uses
wgpu/naga, Safari has its own compiler, and each translates to a different
backend language. Compile time is recorded too — it is a leading cause of
first-frame stalls on slow devices.

**Limits** — declared values are requested for real, then bisected to find the
actual ceiling when the device refuses.

**Rendering benchmarks** — separated by axis rather than collapsed into a score.
Draw call overhead, pipeline switching, bind group switching, fill rate,
fragment ALU, geometry throughput, and texture bandwidth. A device that is cheap
on draw calls but weak on fill rate needs the opposite optimization from one
that is the reverse, and a single number erases that.

## Measurement notes

Getting numbers is easy. Getting numbers that mean anything took most of the work.

**Timestamp quantization.** Browsers round `timestamp-query` results to coarse
buckets as a Spectre mitigation — around 131μs in Chrome at the time of writing.
Any pass shorter than one bucket collapses to the same value, so unrelated
benchmarks report identical timings and throughput figures become fiction. Each
benchmark therefore defines only a *unit* of work and scales its repetition count
until the measured duration clears the bucket by two orders of magnitude.

**Draw call cost is not GPU time.** The expense of a draw call lives in browser
validation and driver calls, which barely register on GPU timestamps. Those
benchmarks are wall-clock by design, and the profile records which clock produced
each number.

**Coefficient of variation is reported per result.** A number you cannot trust is
worse than no number, so instability is surfaced rather than averaged away.

## Feature-aware baselines

WebGPU extends core capabilities through features — `texture-formats-tier1` adds
storage binding to a set of formats, `float32-blendable` adds blending to 32-bit
float targets, and so on. Comparing measurements against a fixed core baseline
produces a flood of false "this implementation is more permissive than spec"
reports. gpu-atlas raises its baseline to match the features a device actually
declares before comparing, so what remains is genuine divergence.

## The profile

`probe()` returns a JSON-serializable `AtlasProfile` with `declared` and
`verified` kept strictly separate, plus a `discrepancies` list where they
disagree. Each discrepancy carries a severity:

- `breaking` — code relying on the declared value will fail on this device
- `degraded` — it works, but slower or with reduced capability
- `note` — a divergence worth recording, not worth acting on

## Status

Early. The probe works and the measurements are sound. The intent is to
accumulate profiles across real devices, because the value of this data compounds
— one device tells you about one device, while thousands tell you which
capabilities are safe to depend on and where the actual cliffs are. A runtime
layer that consumes that data to pick working code paths is the direction, not
yet the reality.

## License

MIT
