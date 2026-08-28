import { describe, it, expect } from 'vitest';
import { parseLoose, asProfile } from './parse.js';

const profile = (fingerprint: string) => ({ schema: 4, fingerprint });

describe('parseLoose', () => {
  it('reads a single object', () => {
    expect(parseLoose(JSON.stringify(profile('aaa')))).toEqual([profile('aaa')]);
  });

  it('reads an array', () => {
    const both = [profile('aaa'), profile('bbb')];
    expect(parseLoose(JSON.stringify(both))).toEqual(both);
  });

  it('reads objects pasted back to back', () => {
    // What happens when someone copies two saved files in sequence.
    const text = `${JSON.stringify(profile('aaa'))}\n${JSON.stringify(profile('bbb'))}`;
    expect(parseLoose(text)).toEqual([profile('aaa'), profile('bbb')]);
  });

  it('is not confused by braces inside strings', () => {
    // Error messages in real profiles contain braces and quotes.
    const tricky = { schema: 4, fingerprint: 'aaa', note: 'a } brace and a " quote' };
    expect(parseLoose(JSON.stringify(tricky))).toEqual([tricky]);
  });

  it('is not confused by escaped backslashes before a quote', () => {
    const tricky = { schema: 4, fingerprint: 'aaa', note: 'ends with a backslash \\' };
    expect(parseLoose(JSON.stringify(tricky))).toEqual([tricky]);
  });

  it('handles nested objects when scanning', () => {
    const nested = { schema: 4, fingerprint: 'aaa', inner: { deeper: { x: 1 } } };
    const text = `${JSON.stringify(nested)} ${JSON.stringify(profile('bbb'))}`;
    expect(parseLoose(text)).toEqual([nested, profile('bbb')]);
  });

  it('rejects empty input', () => {
    expect(() => parseLoose('   ')).toThrow(/nothing to parse/);
  });

  it('rejects text containing no object', () => {
    expect(() => parseLoose('just some words')).toThrow(/could not parse/);
  });
});

describe('asProfile', () => {
  it('accepts a profile', () => {
    expect(asProfile(profile('aaa')).fingerprint).toBe('aaa');
  });

  it('accepts an older schema', () => {
    // Comparison handles old profiles deliberately; parsing must not reject them.
    expect(asProfile({ schema: 1, fingerprint: 'old' }).schema).toBe(1);
  });

  it('rejects a non-object', () => {
    expect(() => asProfile('nope')).toThrow();
    expect(() => asProfile(null)).toThrow();
  });

  it('rejects an object that is not a profile', () => {
    expect(() => asProfile({ hello: 'world' })).toThrow(/no fingerprint/);
    expect(() => asProfile({ fingerprint: 'aaa' })).toThrow(/no schema/);
  });
});
