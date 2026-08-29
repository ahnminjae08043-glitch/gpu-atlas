# Reference profiles

Every number in the top-level README comes from these files. They are here so
the claims can be checked rather than taken on trust:

```js
import { compareProfiles, formatComparison } from 'gpu-atlas';
console.log(formatComparison(compareProfiles([chrome, edge, tablet, phone])));
```

| file | device |
|---|---|
| `nvidia-lovelace-chrome.json` | RTX 4060, Chrome 151, Windows |
| `nvidia-lovelace-edge.json` | RTX 4060, Edge 152, Windows — the same machine |
| `apple-safari.json` | iPad, Safari 26.6 |
| `adreno-7xx-samsung-internet.json` | Adreno 7xx, Samsung Internet 30, Android 16 |

Chrome and Edge share a machine on purpose. They are the only pair that holds
the hardware fixed, which is what makes it possible to say the browser accounts
for at most 1.14x while the device accounts for 65x.

Three of these were captured at schema 4, before iPadOS detection was fixed —
which is why `apple-safari.json` reports `mobile: false` and no `platform`. The
Edge profile is schema 5 and is the first to name its browser correctly; before
that fix the same run called itself `Chromium 152.0.7977.65`, taking Chromium's
version instead of Edge's own `152.0.4191.53`. Benchmarks are unaffected by
either bug — only the environment labelling was wrong.

Contributions are welcome and the bar is low: run the
[demo](https://ahnminjae08043-glitch.github.io/gpu-atlas/), press **Share
profile**, paste. Firefox and the iPhone are the two biggest gaps.
