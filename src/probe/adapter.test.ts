import { describe, it, expect } from 'vitest';
import { pickBrand, parseUA } from './adapter.js';

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

// The fallback runs whenever UA-CH is missing: Firefox and Safari always, and
// Chromium builds that withhold their brands. Every string here is a real one.
describe('parseUA', () => {
  const cases: Array<[string, string, string]> = [
    ['Firefox', '133.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0'],
    ['Firefox', '133.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/133.0 Mobile/15E148 Safari/605.1.15'],
    ['Samsung Internet', '27.0',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36'],
    ['Vivaldi', '7.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Vivaldi/7.0'],
    ['Yandex', '24.12.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 YaBrowser/24.12.0 Safari/537.36'],
    ['Edge', '152.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0'],
    ['Edge', '131.0.0.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/131.0.0.0 Mobile/15E148 Safari/605.1.15'],
    ['Opera', '117.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0'],
    ['Chrome', '151.0.0.0',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36'],
    ['Chrome', '131.0.0.0',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1'],
    ['Safari', '18.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'],
  ];

  for (const [browser, version, ua] of cases) {
    it(`reads ${browser} ${version}`, () => {
      expect(parseUA(ua)).toEqual({ browser, version });
    });
  }

  it('says so rather than guessing', () => {
    expect(parseUA('some crawler/1.0')).toEqual({ browser: 'unknown', version: '' });
  });

  it('cannot tell Brave from Chrome, which is deliberate on Brave part', () => {
    // Brave ships Chrome's exact user agent. Without UA-CH there is nothing to
    // detect, and inventing a guess would be worse than reporting what it says.
    const brave = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    expect(parseUA(brave).browser).toBe('Chrome');
  });
});
