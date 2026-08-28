import { describe, it, expect } from 'vitest';
import { behavesLikeBucket, estimateBucket } from './quantization.js';

// The readings below are shaped after what real browsers returned. Chromium
// quantizes GPU timestamps to 2^16 ns; WebKit does not quantize them at all,
// and its smallest reading is just whatever the shortest pass cost.
const CHROMIUM_BUCKET = 65536;

describe('behavesLikeBucket', () => {
  it('accepts readings that are exact multiples', () => {
    const readings = [1, 2, 3, 5, 8].map((n) => n * CHROMIUM_BUCKET);
    expect(behavesLikeBucket(readings, CHROMIUM_BUCKET)).toBe(true);
  });

  it('accepts readings a hair off a multiple', () => {
    // Real values arrive with a little rounding on them.
    const readings = [
      CHROMIUM_BUCKET * 2 + 200,
      CHROMIUM_BUCKET * 3 - 300,
      CHROMIUM_BUCKET * 5 + 100,
      CHROMIUM_BUCKET * 8,
    ];
    expect(behavesLikeBucket(readings, CHROMIUM_BUCKET)).toBe(true);
  });

  it('tolerates a single stray reading', () => {
    const readings = [
      CHROMIUM_BUCKET, CHROMIUM_BUCKET * 2, CHROMIUM_BUCKET * 3,
      CHROMIUM_BUCKET * 4, CHROMIUM_BUCKET * 5, CHROMIUM_BUCKET * 6,
      CHROMIUM_BUCKET * 7, CHROMIUM_BUCKET * 8, CHROMIUM_BUCKET * 9,
      CHROMIUM_BUCKET * 10 + 30000,
    ];
    expect(behavesLikeBucket(readings, CHROMIUM_BUCKET)).toBe(true);
  });

  it('rejects readings that scatter', () => {
    const readings = [1249, 3871, 5002, 9410, 11733];
    expect(behavesLikeBucket(readings, 1249)).toBe(false);
  });

  it('rejects a non-positive bucket', () => {
    expect(behavesLikeBucket([1, 2, 3], 0)).toBe(false);
    expect(behavesLikeBucket([1, 2, 3], -5)).toBe(false);
  });

  it('rejects an empty set of readings', () => {
    expect(behavesLikeBucket([], CHROMIUM_BUCKET)).toBe(false);
  });
});

describe('estimateBucket', () => {
  it('recovers the bucket from quantized readings', () => {
    const readings = [2, 3, 5, 8, 13].map((n) => n * CHROMIUM_BUCKET);
    expect(estimateBucket(readings)).toBe(CHROMIUM_BUCKET);
  });

  it('recovers it when the smallest reading is several buckets up', () => {
    // Nothing guarantees a 1x reading appears; the gap between readings carries
    // the same information.
    const readings = [4, 5, 6, 7].map((n) => n * CHROMIUM_BUCKET);
    expect(estimateBucket(readings)).toBe(CHROMIUM_BUCKET);
  });

  it('returns null for a timer that is merely fine-grained', () => {
    // Shaped after WebKit: the smallest reading is the cost of the smallest
    // pass, and later readings do not line up behind it.
    const readings = [1249, 4870, 9531, 13844, 15899];
    expect(estimateBucket(readings)).toBeNull();
  });

  it('returns null without enough readings to judge', () => {
    expect(estimateBucket([CHROMIUM_BUCKET, CHROMIUM_BUCKET * 2])).toBeNull();
  });

  it('ignores zero and negative readings', () => {
    // Zero means the work fit inside one bucket, which is not a duration.
    const readings = [0, 0, -1, CHROMIUM_BUCKET, CHROMIUM_BUCKET * 2];
    expect(estimateBucket(readings)).toBeNull();
  });

  it('returns null when every reading is zero', () => {
    expect(estimateBucket([0, 0, 0, 0, 0, 0])).toBeNull();
  });
});
