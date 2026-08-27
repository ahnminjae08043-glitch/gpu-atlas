// gpu-atlas 프로파일 스키마.
//
// 이 라이브러리의 전제: adapter.limits / adapter.features 가 말하는 것과
// 그 기기에서 실제로 되는 것은 다르다. 그래서 모든 항목을 두 갈래로 기록한다.
//   declared — 브라우저가 스스로 신고한 값
//   verified — 실제로 만들어보고 그려보고 재본 값
// 둘이 어긋나는 지점이 Discrepancy 이고, 그게 이 프로젝트가 모으려는 데이터다.

export const SCHEMA_VERSION = 1;

// ── 환경 ────────────────────────────────────────────────

export interface EnvironmentInfo {
  userAgent: string;
  /** UA-CH 기반. 없으면 undefined */
  platform?: string;
  /** 'Chrome' | 'Firefox' | 'Safari' | 'Edge' | 'unknown' */
  browser: string;
  browserVersion: string;
  /** 모바일 여부 (UA-CH mobile 힌트 우선, 없으면 UA 추정) */
  mobile: boolean;
  deviceMemoryGB?: number;
  hardwareConcurrency?: number;
  devicePixelRatio: number;
}

// ── 어댑터 ──────────────────────────────────────────────

export interface AdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** 폴백(소프트웨어) 어댑터면 true — 성능 수치의 의미가 완전히 달라진다 */
  isFallbackAdapter: boolean;
  /** requestAdapter 에 넘긴 powerPreference */
  powerPreference: GPUPowerPreference | 'default';
}

// ── 선언된 능력 ─────────────────────────────────────────

export interface DeclaredCapabilities {
  features: string[];
  limits: Record<string, number>;
  /** navigator.gpu.getPreferredCanvasFormat() */
  preferredCanvasFormat: string;
}

// ── 실측 검증 ───────────────────────────────────────────

/** 한 텍스처 포맷이 각 용도로 실제 쓰이는지 */
export interface FormatSupport {
  format: string;
  /** 이 포맷을 쓰려면 필요한 feature (없으면 코어 포맷) */
  requiresFeature?: string;
  /** 해당 feature 가 declared.features 에 있는가 */
  featureDeclared: boolean;
  /** createTexture 자체가 되는가 */
  creatable: boolean;
  /** TEXTURE_BINDING 으로 셰이더에서 샘플링되는가 */
  sampleable: boolean;
  /** RENDER_ATTACHMENT 로 실제 렌더패스가 도는가 */
  renderable: boolean;
  /** 렌더타겟으로서 블렌딩이 되는가 */
  blendable: boolean;
  /** STORAGE_BINDING 으로 컴퓨트에서 write 되는가 */
  storageWritable: boolean;
  /** 4x MSAA 렌더타겟이 되는가 */
  multisample4x: boolean;
  /** 각 단계에서 잡힌 에러 메시지 (진단용) */
  errors: string[];
}

/** WGSL 컴파일 케이스 하나의 결과 */
export interface ShaderCase {
  id: string;
  /** 무엇을 검사하는 케이스인지 */
  description: string;
  compiled: boolean;
  /** 컴파일은 됐는데 파이프라인 생성에서 죽는 경우가 실제로 있다 */
  pipelineCreated: boolean;
  /** getCompilationInfo() 의 경고/에러 */
  messages: ShaderMessage[];
  /** 컴파일에 걸린 시간(ms). 셰이더 컴파일이 느린 기기 판별용 */
  compileMs: number;
}

export interface ShaderMessage {
  type: 'error' | 'warning' | 'info';
  message: string;
  lineNum: number;
}

/** 선언된 limit 을 실제로 그 값까지 쓸 수 있는지 */
export interface LimitProbe {
  limit: string;
  declared: number;
  /** 실제로 할당/생성에 성공한 최대값. 이분탐색으로 찾는다 */
  achieved: number;
  /** achieved < declared 이면 선언이 거짓말이라는 뜻 */
  honored: boolean;
  error?: string;
}

export interface VerifiedCapabilities {
  formats: FormatSupport[];
  shaders: ShaderCase[];
  limits: LimitProbe[];
  /** device 를 얻는 것 자체가 실패했는가 */
  deviceLost: boolean;
  deviceLostReason?: string;
}

// ── 벤치마크 ────────────────────────────────────────────

export interface BenchResult {
  id: string;
  description: string;
  /** 대표값 (중앙값), ms */
  medianMs: number;
  /** 최소값 — 노이즈가 적은 하한 */
  minMs: number;
  /** 반복 측정의 변동계수. 높으면 이 수치를 믿으면 안 된다 */
  variation: number;
  /** 벤치가 정의한 단위 처리량 (예: 드로우콜/초, MPixel/초) */
  throughput?: number;
  throughputUnit?: string;
  /** GPU 타임스탬프 기반인지, 벽시계 기반인지 */
  timing: 'timestamp-query' | 'wall-clock';
  samples: number;
  failed?: string;
}

export interface BenchmarkResults {
  results: BenchResult[];
  /** timestamp-query 를 쓸 수 있었는가 */
  timestampQuery: boolean;
  /** 전체 벤치에 걸린 실제 시간 */
  totalMs: number;
}

// ── 불일치 ──────────────────────────────────────────────

export type DiscrepancyKind =
  | 'format-declared-not-usable'   // feature 는 있다는데 실제로 못 씀
  | 'format-usable-not-declared'   // 선언에 없는데 실제로는 됨
  | 'limit-not-honored'            // limit 값까지 실제로 못 씀
  | 'shader-compile-failure'       // 표준 WGSL 인데 컴파일 실패
  | 'shader-pipeline-failure'      // 컴파일은 됐는데 파이프라인 생성 실패
  | 'performance-cliff';           // 같은 작업인데 비정상적으로 느림

export interface Discrepancy {
  kind: DiscrepancyKind;
  /** 어느 항목에서 났는지 (포맷명, limit명, 셰이더 케이스 id) */
  subject: string;
  detail: string;
  /** 심각도 — 'breaking' 은 이 기기에서 코드가 그냥 죽는다는 뜻 */
  severity: 'breaking' | 'degraded' | 'note';
}

// ── 최종 프로파일 ───────────────────────────────────────

export interface AtlasProfile {
  schema: number;
  capturedAt: string;
  /** 같은 기기+브라우저 조합을 묶기 위한 안정적 해시 */
  fingerprint: string;
  environment: EnvironmentInfo;
  adapter: AdapterIdentity | null;
  declared: DeclaredCapabilities | null;
  verified: VerifiedCapabilities | null;
  benchmarks: BenchmarkResults | null;
  discrepancies: Discrepancy[];
  /** WebGPU 자체를 못 쓴 경우의 사유 */
  unavailable?: string;
  /** 프로브 전체 소요 시간 */
  elapsedMs: number;
}

// ── 프로브 옵션 ─────────────────────────────────────────

export interface ProbeOptions {
  /** 어느 GPU 를 요청할지. 노트북은 이 값에 따라 다른 칩이 잡힌다 */
  powerPreference?: GPUPowerPreference;
  /** 벤치마크를 돌릴지. false 면 능력 검증만 (수 ms 로 끝남) */
  benchmark?: boolean;
  /** 벤치 반복 횟수. 높이면 정확하지만 오래 걸린다 */
  benchSamples?: number;
  /** 진행 상황 콜백 */
  onProgress?: (stage: string, ratio: number) => void;
  /** 검증할 텍스처 포맷을 직접 지정 (기본: 내장 목록 전체) */
  formats?: string[];
}
