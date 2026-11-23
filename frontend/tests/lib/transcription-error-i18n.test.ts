/**
 * Rust-emitted transcription error codes must have catalog keys (native-i18n
 * spec D7, ticket 05).
 *
 * The frontend builds the key dynamically (`transcription.errors.${suffix}`),
 * which the `i18n-usage` guard exempts by design, so this test is the pin:
 * every `pub const TRANSCRIPTION_*: &str = "transcription.…"` in the Rust
 * error-code registry (`src-tauri/src/error_codes.rs`) must resolve to a
 * non-empty string in BOTH locales under `transcription.errors.` — the same
 * discipline ticket 06 set for the progress codes.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

const REGISTRY = '../../src-tauri/src/error_codes.rs';

/** `pub const TRANSCRIPTION_[A-Z_]+: &str = "transcription.value";` → values. */
function registryCodes(source: string): string[] {
  return [
    ...source.matchAll(/pub const TRANSCRIPTION_[A-Z_]+: &str =\s*\n?\s*"(transcription\.[a-z_]+)";/g),
  ].map((m) => m[1]);
}

type Catalog = Record<string, unknown>;

function lookup(catalog: Catalog, path: string): string | null {
  let node: unknown = catalog;
  for (const part of path.split('.')) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Catalog)[part];
  }
  return typeof node === 'string' && node.trim() ? node : null;
}

describe('transcription error code registry', () => {
  const source = readFileSync(new URL(REGISTRY, import.meta.url), 'utf8');
  const codes = registryCodes(source);

  test('the registry defines codes to check', () => {
    // Guards the extraction itself: a renamed const shape must not silently
    // shrink the checked set to zero.
    expect(codes.length).toBeGreaterThanOrEqual(15);
  });

  test('every registry code resolves in both locales', () => {
    for (const locale of ['en', 'ru'] as const) {
      const catalog = locale === 'en' ? (en as Catalog) : (ru as Catalog);
      for (const code of codes) {
        const suffix = code.slice('transcription.'.length);
        const key = `transcription.errors.${suffix}`;
        expect(lookup(catalog, key), `${locale}: missing catalog key ${key}`).not.toBeNull();
      }
    }
  });

  test('no catalog key exists without a registry code (orphan keys)', () => {
    // The other direction: a key nobody emits is a string that will rot
    // untranslated. `audio_too_short` is counted in worker.rs but not
    // emitted, yet it is coded for family completeness — the registry stays
    // the single list, so the sets must match exactly.
    const errors = (en as Catalog).transcription as Catalog;
    const keys = Object.keys(errors.errors as Catalog);
    const suffixes = new Set(codes.map((code) => code.slice('transcription.'.length)));
    expect(keys.filter((key) => !suffixes.has(key))).toEqual([]);
  });
});
