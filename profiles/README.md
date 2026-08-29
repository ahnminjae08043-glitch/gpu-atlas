# Reference profiles

The three devices the numbers in the top-level README come from. They are here
so the claims can be checked rather than taken on trust:

```js
import { compareProfiles, formatComparison } from 'gpu-atlas';
console.log(formatComparison(compareProfiles([desktop, tablet, phone])));
```

| file | device |
|---|---|
| `nvidia-lovelace-chrome.json` | RTX 4060, Chrome 151, Windows |
| `apple-safari.json` | iPad, Safari 26.6 |
| `adreno-7xx-samsung-internet.json` | Adreno 7xx, Samsung Internet 30, Android 16 |

All three were captured at schema 4, before iPadOS detection was fixed — which
is why `apple-safari.json` reports `mobile: false` and no `platform`. Its
benchmarks are unaffected; only the environment labelling was wrong.

Contributions are welcome and the bar is low: run the
[demo](https://ahnminjae08043-glitch.github.io/gpu-atlas/), press **Share
profile**, paste. Firefox and iPhone are the two biggest gaps.
