import { describe, expect, test } from 'bun:test';

import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

/**
 * Catalog-vs-catalog guard (native-i18n spec D6).
 *
 * Model-card descriptions are localized in the frontend catalogs, resolved by
 * the model `family` (`models.transcribeCpp.descriptions.<family>` /
 * `models.audioCpp.descriptions.<family>`), following the `taskLabel()`
 * precedent. The Rust static catalogs remain the source of truth for which
 * families exist, so the guard parses their `family:` declarations out of the
 * `.rs` sources and requires every family — and only those families — to have
 * a description key in BOTH locales. This is the ticket-04 consequence: a
 * newly added model without keys must fail here rather than render an empty
 * card, and a removed model must not leave orphan keys behind.
 *
 * Parsing regex: every catalogued model declares exactly one `family: "..."`
 * entry line (macro input in transcribe.cpp, struct field in audio.cpp). The
 * macro's own `family: $family:expr` has no quoted literal, so it cannot
 * produce a false positive; the `EXPECTED`/`RUSSIAN_CAPABLE` test constants
 * are plain string arrays, likewise invisible to the regex. The non-empty
 * assertions below keep a broken regex from passing vacuously.
 */

const TRANSCRIBE_CPP_CATALOG = '../../src-tauri/src/transcribe_cpp_engine/catalog.rs';
const AUDIO_CPP_CATALOG = '../../src-tauri/src/audio_cpp_engine/catalog.rs';

const FAMILY_RE = /family:\s*"([^"]+)"/g;

async function familiesIn(rustCatalogPath: string): Promise<string[]> {
  const source = await Bun.file(new URL(rustCatalogPath, import.meta.url)).text();
  return [...source.matchAll(FAMILY_RE)].map(match => match[1]);
}

/** The localized descriptions for one manager, keyed by family. */
function descriptions(catalog: unknown, manager: 'transcribeCpp' | 'audioCpp'): Record<string, unknown> {
  const node = (catalog as Record<string, any>).models?.[manager]?.descriptions;
  return node !== null && typeof node === 'object' ? node : {};
}

async function expectFamilyKeys(
  manager: 'transcribeCpp' | 'audioCpp',
  rustCatalogPath: string,
  minimumFamilies: number,
) {
  const families = await familiesIn(rustCatalogPath);
  // A broken regex must not pass vacuously.
  expect(families.length).toBeGreaterThanOrEqual(minimumFamilies);
  expect(new Set(families).size).toBe(families.length); // each family once

  for (const [language, catalog] of Object.entries({ en, ru })) {
    const keys = descriptions(catalog, manager);
    const missing = families.filter(family => typeof keys[family] !== 'string' || !keys[family].trim());
    expect({ language, missing }).toEqual({ language, missing: [] });
    // No orphan keys: removing a model from the Rust catalog must update the locales.
    const orphan = Object.keys(keys).filter(family => !families.includes(family));
    expect({ language, orphan }).toEqual({ language, orphan: [] });
  }
}

describe('model catalog descriptions', () => {
  test('every transcribe.cpp family has a description key in both locales', async () => {
    await expectFamilyKeys('transcribeCpp', TRANSCRIBE_CPP_CATALOG, 10);
  });

  test('every audio.cpp family has a description key in both locales', async () => {
    await expectFamilyKeys('audioCpp', AUDIO_CPP_CATALOG, 1);
  });
});
