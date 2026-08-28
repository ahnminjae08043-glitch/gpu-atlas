// Deciding whether a timer is quantized, from its readings alone.
//
// Split out from the benchmark code because it is pure arithmetic and the
// judgement it makes is subtle enough to be worth testing directly: getting it
// wrong made the same machine report a different timer on consecutive runs.

/** Fraction of readings that must be multiples before a bucket is believed */
const AGREEMENT = 0.9;
/** How far a reading may sit from a multiple, as a fraction of the bucket */
const TOLERANCE = 0.02;
/** Fewer readings than this and there is nothing to conclude */
const MIN_READINGS = 4;

/**
 * Whether readings are consistently multiples of the candidate bucket.
 *
 * Under real quantization every reading is a multiple of the bucket. On a timer
 * that is merely fine-grained, the smallest reading is just how long the
 * smallest workload happened to take and later readings fall wherever they like.
 */
export function behavesLikeBucket(readings: number[], bucket: number): boolean {
  if (bucket <= 0 || readings.length === 0) return false;

  const tolerance = bucket * TOLERANCE;
  let multiples = 0;
  for (const v of readings) {
    const remainder = v % bucket;
    if (remainder <= tolerance || remainder >= bucket - tolerance) multiples++;
  }

  // Allow a stray reading; demand the rest line up.
  return multiples / readings.length >= AGREEMENT;
}

/**
 * Estimate the quantization bucket from timer readings, or null when the timer
 * does not appear to be quantized at all.
 *
 * The candidate is the smaller of the smallest reading and the smallest gap
 * between distinct readings — under quantization both are multiples of the
 * bucket. It is then checked against every reading before being believed,
 * because a single number cannot distinguish a bucket from a short workload.
 */
export function estimateBucket(readings: number[]): number | null {
  const positive = readings.filter((v) => v > 0 && Number.isFinite(v));
  if (positive.length < MIN_READINGS) return null;

  const smallest = Math.min(...positive);

  const distinct = [...new Set(positive)].sort((a, b) => a - b);
  let smallestGap = Infinity;
  for (let i = 1; i < distinct.length; i++) {
    smallestGap = Math.min(smallestGap, distinct[i] - distinct[i - 1]);
  }

  const estimate = Math.min(smallest, smallestGap);
  if (!Number.isFinite(estimate) || estimate <= 0) return null;

  return behavesLikeBucket(positive, estimate) ? estimate : null;
}
