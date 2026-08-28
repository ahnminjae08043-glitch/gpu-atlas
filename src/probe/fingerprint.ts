// Identifying a device + browser combination.
//
// This is a grouping key, not an identifier for a person: it is derived only
// from the adapter's self-description and the browser's major version, both of
// which are shared by every machine of the same model.
//
// Width matters more than it looks. Collecting profiles in bulk is the point of
// the project, and a 32-bit key collides with better-than-even odds once there
// are ~77,000 of them. A collision silently merges two different devices, which
// corrupts exactly the dataset the project exists to build, so the key is 128
// bits.

/** Bytes of hash to keep — 16 bytes renders as 32 hex characters */
const KEY_BYTES = 16;

export interface FingerprintInput {
  browser: string;
  browserVersion: string;
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

export function fingerprintSource(input: FingerprintInput): string {
  // Only the major version: patch releases are the same device to us, and
  // including them would fragment the grouping for no benefit.
  const major = input.browserVersion.split('.')[0] ?? '';
  return [
    input.browser,
    major,
    input.vendor,
    input.architecture,
    input.device,
    input.description,
  ].join('|');
}

export async function fingerprint(input: FingerprintInput): Promise<string> {
  const text = fingerprintSource(input);

  // SubtleCrypto needs a secure context. WebGPU does too, so this is available
  // on any device that produced a real profile — but a profile recording that
  // WebGPU was unavailable might come from somewhere it is not.
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
      return toHex(new Uint8Array(digest).subarray(0, KEY_BYTES));
    } catch {
      // Fall through to the pure-JS path.
    }
  }

  return fnv1a128(text);
}

/**
 * FNV-1a widened to 128 bits by running four independent lanes with different
 * offset bases. Not a cryptographic hash — it only needs to spread device
 * descriptions well enough that collisions stay unlikely.
 */
export function fnv1a128(text: string): string {
  const PRIME = 0x01000193;
  const lanes = [0x811c9dc5, 0x1000193, 0xcbf29ce4, 0x84222325];

  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    for (let l = 0; l < lanes.length; l++) {
      // Perturb each lane differently so they do not collapse into one value.
      lanes[l] ^= c + l * 0x9e37;
      lanes[l] = Math.imul(lanes[l], PRIME) >>> 0;
    }
  }

  return lanes.map((v) => v.toString(16).padStart(8, '0')).join('');
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}
