// gpu-atlas profile schema.
//
// The premise of this library: what adapter.limits / adapter.features claim and
// what the device actually does are different things. So every capability is
// recorded along two tracks:
//   declared — what the browser reported about itself
//   verified — what actually worked when we created it, drew with it, measured it
// Where the two disagree is a Discrepancy, and that is the data this project
// exists to collect.

export const SCHEMA_VERSION = 1;

// ── Environment ─────────────────────────────────────────

export interface EnvironmentInfo {
  userAgent: string;
  /** From UA-CH when available */
  platform?: string;
  /** 'Chrome' | 'Firefox' | 'Safari' | 'Edge' | 'unknown' */
  browser: string;
  browserVersion: string;
  /** Prefers the UA-CH mobile hint, falls back to UA sniffing */
  mobile: boolean;
  deviceMemoryGB?: number;
  hardwareConcurrency?: number;
  devicePixelRatio: number;
}

// ── Adapter ─────────────────────────────────────────────

export interface AdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  /** A software adapter — every performance number means something else entirely */
  isFallbackAdapter: boolean;
  /** The powerPreference passed to requestAdapter */
  powerPreference: GPUPowerPreference | 'default';
}

// ── Declared capabilities ───────────────────────────────

export interface DeclaredCapabilities {
  features: string[];
  limits: Record<string, number>;
  /** navigator.gpu.getPreferredCanvasFormat() */
  preferredCanvasFormat: string;
}

// ── Verified capabilities ───────────────────────────────

/** Whether a texture format actually works for each usage */
export interface FormatSupport {
  format: string;
  /** The device feature this format requires, if any */
  requiresFeature?: string;
  /** Whether that feature appears in declared.features */
  featureDeclared: boolean;
  /** createTexture succeeds */
  creatable: boolean;
  /** Readable from a shader via TEXTURE_BINDING */
  sampleable: boolean;
  /** A render pass actually runs against it via RENDER_ATTACHMENT */
  renderable: boolean;
  /** Blending works when used as a render target */
  blendable: boolean;
  /** Writable from a compute shader via STORAGE_BINDING */
  storageWritable: boolean;
  /** Works as a 4x MSAA render target */
  multisample4x: boolean;
  /** Errors captured at each stage, for diagnosis */
  errors: string[];
}

/** Result of one WGSL compilation case */
export interface ShaderCase {
  id: string;
  /** What this case is probing for */
  description: string;
  /** Skipped because a required feature is missing */
  skipped: boolean;
  compiled: boolean;
  /** Compiling can succeed while pipeline creation still fails — it happens */
  pipelineCreated: boolean;
  /** Warnings and errors from getCompilationInfo() */
  messages: ShaderMessage[];
  /** Compile time in ms. Identifies devices with slow shader compilation */
  compileMs: number;
}

export interface ShaderMessage {
  type: 'error' | 'warning' | 'info';
  message: string;
  lineNum: number;
}

/** Whether a declared limit can actually be used up to its stated value */
export interface LimitProbe {
  limit: string;
  declared: number;
  /** Highest value that actually allocated, found by bisection */
  achieved: number;
  /** achieved < declared means the declaration was not honored */
  honored: boolean;
  error?: string;
}

export interface VerifiedCapabilities {
  formats: FormatSupport[];
  shaders: ShaderCase[];
  limits: LimitProbe[];
  /** The device died partway through — everything after that is meaningless */
  deviceLost: boolean;
  deviceLostReason?: string;
}

// ── Benchmarks ──────────────────────────────────────────

export interface BenchResult {
  id: string;
  description: string;
  /** Representative value (median), in ms */
  medianMs: number;
  /** Lowest sample — a noise-free floor */
  minMs: number;
  /** Coefficient of variation. High means this number should not be trusted */
  variation: number;
  /** Throughput in the unit this benchmark defines (draws/s, MPixel/s, ...) */
  throughput?: number;
  throughputUnit?: string;
  /** Whether this came from GPU timestamps or the wall clock */
  timing: 'timestamp-query' | 'wall-clock';
  samples: number;
  /** How many unit workloads were run per sample after auto-scaling */
  repetitions: number;
  /**
   * Measured duration expressed in timer resolution units. Low values mean the
   * number is riding on the quantization floor and carries little information,
   * which is the one case where a variation of 0 must not be read as stability.
   */
  ticks?: number;
  /** The measurement sits too close to the timer resolution to be trusted */
  quantized?: boolean;
  failed?: string;
}

export interface BenchmarkResults {
  results: BenchResult[];
  /** Whether timestamp-query was usable */
  timestampQuery: boolean;
  /**
   * Measured granularity of the GPU timer, in nanoseconds. Browsers round
   * timestamps into coarse buckets as a Spectre mitigation and the bucket size
   * differs per browser and device, so it is measured rather than assumed.
   */
  timerResolutionNs: number | null;
  /** Wall-clock time the whole benchmark suite took */
  totalMs: number;
}

// ── Discrepancies ───────────────────────────────────────

export type DiscrepancyKind =
  | 'format-declared-not-usable'   // feature is declared but the format does not work
  | 'format-usable-not-declared'   // not declared, yet it works anyway
  | 'limit-not-honored'            // the declared limit cannot actually be reached
  | 'shader-compile-failure'       // valid WGSL that failed to compile
  | 'shader-pipeline-failure'      // compiled, but pipeline creation failed
  | 'performance-cliff';           // same work, anomalously slow or unstable

export interface Discrepancy {
  kind: DiscrepancyKind;
  /** Where it occurred — a format name, limit name, or shader case id */
  subject: string;
  detail: string;
  /** 'breaking' means code relying on the declaration will fail on this device */
  severity: 'breaking' | 'degraded' | 'note';
}

// ── The profile ─────────────────────────────────────────

export interface AtlasProfile {
  schema: number;
  capturedAt: string;
  /** Stable hash grouping the same device + browser combination */
  fingerprint: string;
  environment: EnvironmentInfo;
  adapter: AdapterIdentity | null;
  declared: DeclaredCapabilities | null;
  verified: VerifiedCapabilities | null;
  benchmarks: BenchmarkResults | null;
  discrepancies: Discrepancy[];
  /** Why WebGPU could not be used at all, when that is the case */
  unavailable?: string;
  /** Total time the probe took */
  elapsedMs: number;
}

// ── Probe options ───────────────────────────────────────

export interface ProbeOptions {
  /** Which GPU to ask for. On laptops this decides which chip you get */
  powerPreference?: GPUPowerPreference;
  /** Run benchmarks. false leaves only capability verification, which is fast */
  benchmark?: boolean;
  /** Samples per benchmark. More is more accurate and slower */
  benchSamples?: number;
  /** Progress callback */
  onProgress?: (stage: string, ratio: number) => void;
  /** Verify only these texture formats (default: the full built-in list) */
  formats?: string[];
}
