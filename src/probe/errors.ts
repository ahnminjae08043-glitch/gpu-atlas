// WebGPU error capture.
//
// WebGPU reports most failures through error scopes rather than exceptions, so
// "createTexture returned an object" guarantees nothing on its own. This wraps a
// call in all three scope types and, where it matters, waits for the queue to
// actually finish the work before judging. Skipping that order lets failures
// slip through silently.
//
// Errors are kept structured rather than formatted into strings. A consumer
// asking "did this fail because the format is unsupported, or because we ran
// out of memory?" should not have to match on message text — that is the same
// fragility that string-matching skipped shader cases had.

import type { ProbeError, ProbeErrorKind } from '../types.js';

const SCOPES: GPUErrorFilter[] = ['validation', 'out-of-memory', 'internal'];

export interface Captured<T> {
  value: T | null;
  errors: ProbeError[];
  ok: boolean;
}

/**
 * Run fn inside error scopes.
 * @param settle wait for submitted work to complete before collecting errors.
 *               Required whenever the check actually draws something.
 */
export async function capture<T>(
  device: GPUDevice,
  fn: () => T | Promise<T>,
  settle = false,
): Promise<Captured<T>> {
  for (const scope of SCOPES) device.pushErrorScope(scope);

  let value: T | null = null;
  const errors: ProbeError[] = [];

  try {
    value = await fn();
  } catch (e) {
    errors.push({ kind: 'exception', message: describe(e) });
  }

  if (settle && errors.length === 0) {
    try {
      await device.queue.onSubmittedWorkDone();
    } catch (e) {
      errors.push({ kind: 'queue', message: describe(e) });
    }
  }

  // Scopes must be popped in reverse order of pushing.
  for (let i = SCOPES.length - 1; i >= 0; i--) {
    try {
      const err = await device.popErrorScope();
      if (err) errors.push({ kind: SCOPES[i] as ProbeErrorKind, message: err.message });
    } catch (e) {
      // If the device is already gone, popErrorScope itself rejects.
      errors.push({ kind: 'scope-unavailable', message: describe(e) });
    }
  }

  return { value, errors, ok: errors.length === 0 && value !== null };
}

/** When only success or failure matters */
export async function works(
  device: GPUDevice,
  fn: () => unknown | Promise<unknown>,
  settle = false,
): Promise<{ ok: boolean; errors: ProbeError[] }> {
  const r = await capture(device, async () => {
    const v = await fn();
    // capture() treats null as failure, so functions returning undefined need a value.
    return v === undefined ? true : v;
  }, settle);
  return { ok: r.ok, errors: r.errors };
}

/** Tag errors with the check that produced them */
export function atStage(stage: ProbeError['stage'], errors: ProbeError[]): ProbeError[] {
  return errors.map((e) => ({ ...e, stage }));
}

/** First error message, for places that need one line of explanation */
export function firstMessage(errors: ProbeError[]): string {
  return errors[0]?.message ?? 'no error reported';
}

function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}

/** Release GPU resources without caring whether they are already gone */
export function dispose(...resources: Array<{ destroy?: () => void } | null | undefined>): void {
  for (const r of resources) {
    try {
      r?.destroy?.();
    } catch {
      // Already destroyed, or the device died. Either way, nothing to do.
    }
  }
}
