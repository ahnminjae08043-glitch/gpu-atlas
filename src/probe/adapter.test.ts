import { describe, it, expect } from 'vitest';
import { pickBrand } from './adapter.js';

// UA-CH shuffles the order and varies the GREASE entry on every call, so these
// lists are written in the awkward orders real browsers actually produce.
describe('pickBrand', () => {
  it('picks Edge over the generic Chromium entry', () => {
    const list = [
      { brand: 'Not_A Brand', version: '99' },
      { brand: 'Chromium', version: '152.0.7977.65' },
      { brand: 'Microsoft Edge', version: '152.0.3620.51' },
    ];
    expect(pickBrand(list)).toEqual({ brand: 'Microsoft Edge', version: '152.0.3620.51' });
  });

  it('picks the browser even when Chromium is listed last', () => {
    const list = [
      { brand: 'Opera', version: '120.0.0.0' },
      { brand: 'Not;A=Brand', version: '8' },
      { brand: 'Chromium', version: '152.0.7977.65' },
    ];
    expect(pickBrand(list)?.brand).toBe('Opera');
  });

  it('accepts Chromium when that is genuinely all there is', () => {
    // A plain Chromium build lists no other name, and reporting nothing would
    // be worse than reporting what it says it is.
    const list = [
      { brand: 'Not.A/Brand', version: '24' },
      { brand: 'Chromium', version: '152.0.7977.65' },
    ];
    expect(pickBrand(list)?.brand).toBe('Chromium');
  });

  it('picks Google Chrome, which is a name and not the generic entry', () => {
    const list = [
      { brand: 'Chromium', version: '151.0.7922.109' },
      { brand: 'Google Chrome', version: '151.0.7922.109' },
      { brand: 'Not?A_Brand', version: '99' },
    ];
    expect(pickBrand(list)?.brand).toBe('Google Chrome');
  });

  it('returns undefined when nothing survives', () => {
    expect(pickBrand([{ brand: 'Not_A Brand', version: '99' }])).toBeUndefined();
    expect(pickBrand([])).toBeUndefined();
    expect(pickBrand(undefined)).toBeUndefined();
  });
});
