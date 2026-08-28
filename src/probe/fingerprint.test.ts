import { describe, it, expect } from 'vitest';
import { fingerprint, fingerprintSource, fnv1a128 } from './fingerprint.js';

const base = {
  browser: 'Chrome',
  browserVersion: '151.0.7922.109',
  vendor: 'nvidia',
  architecture: 'lovelace',
  device: '',
  description: '',
};

describe('fingerprintSource', () => {
  it('keeps only the browser major version', () => {
    const a = fingerprintSource(base);
    const b = fingerprintSource({ ...base, browserVersion: '151.9.9999.999' });
    // A patch update is the same device; fragmenting on it would split groups
    // for no reason.
    expect(a).toBe(b);
  });

  it('separates different major versions', () => {
    const a = fingerprintSource(base);
    const b = fingerprintSource({ ...base, browserVersion: '152.0.0.0' });
    expect(a).not.toBe(b);
  });

  it('includes the adapter identity', () => {
    const a = fingerprintSource(base);
    const b = fingerprintSource({ ...base, architecture: 'ampere' });
    expect(a).not.toBe(b);
  });
});

describe('fingerprint', () => {
  it('is 32 hex characters', async () => {
    const fp = await fingerprint(base);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is stable for the same device', async () => {
    expect(await fingerprint(base)).toBe(await fingerprint({ ...base }));
  });

  it('differs across GPUs, browsers, and vendors', async () => {
    const mine = await fingerprint(base);
    const others = await Promise.all([
      fingerprint({ ...base, vendor: 'apple' }),
      fingerprint({ ...base, architecture: 'adreno-7xx' }),
      fingerprint({ ...base, browser: 'Safari' }),
      fingerprint({ ...base, browserVersion: '152.0.0.0' }),
    ]);
    for (const other of others) expect(other).not.toBe(mine);
  });
});

describe('fnv1a128 fallback', () => {
  it('is 32 hex characters', () => {
    expect(fnv1a128('anything')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic', () => {
    expect(fnv1a128('Chrome|151|nvidia')).toBe(fnv1a128('Chrome|151|nvidia'));
  });

  it('keeps its lanes independent', () => {
    // Four lanes that ended up equal would give away 96 bits of the key.
    const hex = fnv1a128('Chrome|151|nvidia|lovelace');
    const lanes = [
      hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32),
    ];
    expect(new Set(lanes).size).toBe(4);
  });

  it('spreads similar inputs apart', () => {
    // Adjacent device descriptions must not land on adjacent keys.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(fnv1a128(`Chrome|151|vendor-${i}`));
    expect(seen.size).toBe(500);
  });
});
