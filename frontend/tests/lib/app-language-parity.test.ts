import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * Rust and the frontend must never disagree on the resolved interface
 * language for the same input (native-i18n ticket 02, acceptance "shared
 * cases", spec D11). The case vector is authored on the Rust side, in
 * `src-tauri/src/l10n/language.rs` (`SHARED_RESOLUTION_CASES`); this file
 * parses it out of that source and runs every row through the frontend's own
 * resolution path — the same technique `live-diarization.test.ts` uses for
 * the mirrored native constants, so neither side can quietly drift.
 *
 * The expected codes in the vector are hand-derived literals, not computed by
 * either implementation, which keeps both checks informative rather than
 * tautological.
 */

const RUST_SOURCE = new URL('../../src-tauri/src/l10n/language.rs', import.meta.url);
const BRIDGE_SOURCE = new URL('../../src/lib/app-language.ts', import.meta.url);
const CONTEXT_SOURCE = new URL('../../src/contexts/LanguageContext.tsx', import.meta.url);

const rust = readFileSync(RUST_SOURCE, 'utf8');
const bridge = readFileSync(BRIDGE_SOURCE, 'utf8');
const context = readFileSync(CONTEXT_SOURCE, 'utf8');

/** Extracts a `pub const NAME: &str = "…"；` literal from the Rust source. */
function rustConst(name: string, source: string = rust): string {
  const match = new RegExp(`pub const ${name}: &str =\\s*"([^"]*)"`).exec(source);
  if (!match) {
    throw new Error(`No string constant ${name} in ${source === rust ? RUST_SOURCE.pathname : 'source'}`);
  }
  return match[1];
}

/** Extracts a `const NAME = '…';` literal from a frontend source. */
function tsConst(name: string, source: string): string {
  const match = new RegExp(`(?:export )?const ${name} =\\s*'([^']*)'`).exec(source);
  if (!match) {
    throw new Error(`No string constant ${name}`);
  }
  return match[1];
}

/** Parses `SHARED_RESOLUTION_CASES` rows out of the Rust source. */
function sharedCases(): Array<[string, string, 'en' | 'ru']> {
  const block = /SHARED_RESOLUTION_CASES[^=]*=\s*&\[[\s\S]*?\];/.exec(rust);
  if (!block) {
    throw new Error('No SHARED_RESOLUTION_CASES in language.rs');
  }
  const rows: Array<[string, string, 'en' | 'ru']> = [];
  const row = /\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
  for (let m = row.exec(block[0]); m !== null; m = row.exec(block[0])) {
    const expected = m[3];
    if (expected !== 'en' && expected !== 'ru') {
      throw new Error(`Unexpected expected code ${JSON.stringify(expected)} in the case vector`);
    }
    rows.push([m[1], m[2], expected]);
  }
  return rows;
}

const { resolveAppLanguage } = await import('../../src/i18n');

test('the shared vector has enough rows to be a real guard', () => {
  const cases = sharedCases();
  // An empty or tiny parse would make every other test here vacuous.
  expect(cases.length).toBeGreaterThanOrEqual(15);
  for (const [stored, os, expected] of cases) {
    expect(['en', 'ru']).toContain(expected);
    // `""` is the documented "absent" sentinel for the two inputs.
    expect(typeof stored).toBe('string');
    expect(typeof os).toBe('string');
  }
});

test('the frontend resolves every shared case to the expected code', () => {
  for (const [stored, os, expected] of sharedCases()) {
    const storedInput = stored === '' ? null : stored;
    const osInput = os === '' ? null : os;
    expect(resolveAppLanguage(storedInput, osInput)).toBe(expected);
  }
});

test('the store file and key match the frontend bridge', () => {
  // Rust reads `preferences.json` / `app_language` directly; a rename on the
  // writer side would silently deaden the native language on next start.
  expect(rustConst('PREFERENCES_STORE_FILE')).toBe(tsConst('STORE_FILE', bridge));
  expect(rustConst('APP_LANGUAGE_KEY')).toBe(tsConst('SETTING_KEY', bridge));
  expect(tsConst('STORE_FILE', bridge)).toBe('preferences.json');
  expect(tsConst('SETTING_KEY', bridge)).toBe('app_language');
});

test('the language-changed event name matches on both sides', () => {
  // The frontend emits through the const in `app-language.ts` and the Rust
  // listener subscribes through `LANGUAGE_CHANGED_EVENT`; one literal rules.
  const eventName = tsConst('APP_LANGUAGE_CHANGED_EVENT', bridge);
  expect(eventName).toBe('app-language-changed');
  expect(rustConst('LANGUAGE_CHANGED_EVENT')).toBe(eventName);
});
