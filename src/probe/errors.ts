// WebGPU 에러 수집.
//
// WebGPU 는 대부분의 실패를 예외로 던지지 않고 에러 스코프로 흘린다.
// 그래서 "createTexture 가 성공했다"는 것만으로는 아무것도 보장되지 않는다.
// 여기서 세 종류 스코프를 전부 걸고, 큐가 실제로 일을 끝낼 때까지 기다린 뒤에
// 판정한다. 이 순서를 지키지 않으면 실패가 조용히 새어나간다.

const SCOPES: GPUErrorFilter[] = ['validation', 'out-of-memory', 'internal'];

export interface Captured<T> {
  value: T | null;
  errors: string[];
  ok: boolean;
}

/**
 * fn 을 에러 스코프로 감싸 실행한다.
 * @param settle true 면 큐가 제출된 작업을 끝낼 때까지 기다린 뒤 에러를 걷는다.
 *               실제로 그려보는 검증에는 반드시 필요하다.
 */
export async function capture<T>(
  device: GPUDevice,
  fn: () => T | Promise<T>,
  settle = false,
): Promise<Captured<T>> {
  for (const scope of SCOPES) device.pushErrorScope(scope);

  let value: T | null = null;
  const errors: string[] = [];

  try {
    value = await fn();
  } catch (e) {
    errors.push(`throw: ${describe(e)}`);
  }

  if (settle && errors.length === 0) {
    try {
      await device.queue.onSubmittedWorkDone();
    } catch (e) {
      errors.push(`queue: ${describe(e)}`);
    }
  }

  // push 의 역순으로 pop 해야 한다.
  for (let i = SCOPES.length - 1; i >= 0; i--) {
    try {
      const err = await device.popErrorScope();
      if (err) errors.push(`${SCOPES[i]}: ${err.message}`);
    } catch (e) {
      // 디바이스가 이미 죽었으면 popErrorScope 자체가 거부된다.
      errors.push(`${SCOPES[i]}-scope-failed: ${describe(e)}`);
    }
  }

  return { value, errors, ok: errors.length === 0 && value !== null };
}

/** 성공/실패만 필요할 때 */
export async function works(
  device: GPUDevice,
  fn: () => unknown | Promise<unknown>,
  settle = false,
): Promise<{ ok: boolean; errors: string[] }> {
  const r = await capture(device, async () => {
    const v = await fn();
    // undefined 를 반환하는 함수도 성공으로 치려면 non-null 값이 필요하다.
    return v === undefined ? true : v;
  }, settle);
  return { ok: r.ok, errors: r.errors };
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** 만들어진 GPU 리소스를 안전하게 정리 */
export function dispose(...resources: Array<{ destroy?: () => void } | null | undefined>): void {
  for (const r of resources) {
    try {
      r?.destroy?.();
    } catch {
      // 이미 파괴됐거나 디바이스가 죽은 경우 — 무시해도 안전하다.
    }
  }
}
