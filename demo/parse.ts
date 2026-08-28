// Reading profiles out of whatever a person pastes in.
//
// Split from the UI because this is the part that can actually be wrong, and
// because people paste things in shapes the code did not anticipate: a bare
// object, a JSON array, or several objects run together after copying two
// files one after the other.

import type { AtlasProfile } from '../src/types.js';

/** Parse one JSON value, an array, or several concatenated top-level objects */
export function parseLoose(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('nothing to parse');

  try {
    const v = JSON.parse(trimmed);
    return Array.isArray(v) ? v : [v];
  } catch {
    // Fall through to scanning for consecutive top-level objects.
  }

  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];

    // Braces inside strings are text, not structure.
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }

    if (c === '"') inString = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(trimmed.slice(start, i + 1)));
        start = -1;
      }
    }
  }

  if (out.length === 0) throw new Error('could not parse any JSON object');
  return out;
}

/**
 * Check that a parsed value is actually a profile.
 *
 * Only the fields the comparison depends on are required — being strict about
 * the rest would reject older profiles that comparison handles deliberately.
 */
export function asProfile(value: unknown): AtlasProfile {
  const p = value as AtlasProfile;
  if (!p || typeof p !== 'object') throw new Error('not an object');
  if (typeof p.fingerprint !== 'string' || !p.fingerprint) {
    throw new Error('not a gpu-atlas profile: no fingerprint');
  }
  if (typeof p.schema !== 'number') {
    throw new Error('not a gpu-atlas profile: no schema version');
  }
  return p;
}
