// GPU timing.
//
// With timestamp-query available this measures the time the GPU actually spent
// in the pass; without it, it falls back to wall-clock around submission. The
// two mean different things, so the result records which one produced a number.

export class GpuTimer {
  private querySet: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readBuf: GPUBuffer | null = null;

  private constructor(public readonly available: boolean) {}

  static create(device: GPUDevice): GpuTimer {
    const has = device.features.has('timestamp-query');
    const timer = new GpuTimer(has);
    if (!has) return timer;

    try {
      timer.querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
      timer.resolveBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
      timer.readBuf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    } catch {
      // If creation is refused, quietly drop to wall-clock mode.
      timer.dispose();
      return new GpuTimer(false);
    }
    return timer;
  }

  /** timestampWrites to put on a render pass descriptor */
  writes(): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /** Attach the resolve commands to an encoder whose pass has been recorded */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuf || !this.readBuf) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuf, 0);
    // Skip the copy while a previous read still holds the buffer mapped.
    if (this.readBuf.mapState === 'unmapped') {
      encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, 16);
    }
  }

  /** Call after submitting. Returns GPU time in ms, or null if unreadable */
  async read(): Promise<number | null> {
    if (!this.readBuf || this.readBuf.mapState !== 'unmapped') return null;
    try {
      await this.readBuf.mapAsync(GPUMapMode.READ);
      const raw = new BigInt64Array(this.readBuf.getMappedRange().slice(0));
      this.readBuf.unmap();
      const ns = Number(raw[1] - raw[0]);
      if (!Number.isFinite(ns) || ns <= 0) return null;
      return ns / 1e6;
    } catch {
      return null;
    }
  }

  dispose(): void {
    try { this.querySet?.destroy(); } catch { /* already gone */ }
    try { this.resolveBuf?.destroy(); } catch { /* already gone */ }
    try { this.readBuf?.destroy(); } catch { /* already gone */ }
    this.querySet = null;
    this.resolveBuf = null;
    this.readBuf = null;
  }
}

/** Median */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Coefficient of variation (stddev/mean). Above ~0.2 the number is not trustworthy */
export function variation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const varsum = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varsum) / mean;
}
