// GPU 시간 측정.
//
// timestamp-query 가 있으면 GPU 가 실제로 그 패스에 쓴 시간을 재고, 없으면
// 제출부터 완료까지의 벽시계로 폴백한다. 둘은 의미가 다르므로 결과에 어느 쪽인지 남긴다.
// 브라우저가 스펙터 완화 때문에 타임스탬프 정밀도를 낮춰 놓는 경우가 있어서,
// 분해능이 쓸모없을 만큼 거칠면 스스로 벽시계로 물러난다.

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
      // 생성이 거절되면 조용히 벽시계 모드로 간다.
      timer.dispose();
      return new GpuTimer(false);
    }
    return timer;
  }

  /** 렌더패스 descriptor 에 넣을 timestampWrites */
  writes(): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    return {
      querySet: this.querySet,
      beginningOfPassWriteIndex: 0,
      endOfPassWriteIndex: 1,
    };
  }

  /** 패스 기록이 끝난 인코더에 resolve 명령을 붙인다 */
  resolve(encoder: GPUCommandEncoder): void {
    if (!this.querySet || !this.resolveBuf || !this.readBuf) return;
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuf, 0);
    // 직전 read 가 아직 매핑 중이면 복사를 건너뛴다.
    if (this.readBuf.mapState === 'unmapped') {
      encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, 16);
    }
  }

  /** 제출 후 호출. GPU 시간(ms)을 돌려주고, 읽을 수 없으면 null */
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
    try { this.querySet?.destroy(); } catch { /* 이미 정리됨 */ }
    try { this.resolveBuf?.destroy(); } catch { /* 이미 정리됨 */ }
    try { this.readBuf?.destroy(); } catch { /* 이미 정리됨 */ }
    this.querySet = null;
    this.resolveBuf = null;
    this.readBuf = null;
  }
}

/** 중앙값 */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 변동계수 (표준편차/평균). 0.2 를 넘으면 그 수치는 신뢰하기 어렵다 */
export function variation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const varsum = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(varsum) / mean;
}
