import { describe, expect, test } from 'bun:test';

import { RESOURCES } from '../../src/i18n';
import { LANGUAGE_METADATA } from '../../src/i18n/languages';
import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

/**
 * The two interface catalogs must stay in step. A key added to one and not the
 * other shows up in the app as a raw `settings.foo.title` — the failure mode
 * this test exists to catch before a user sees it.
 *
 * Plural keys compare by their base: Russian needs `_one/_few/_many` where
 * English needs `_one/_other`, so the raw paths legitimately differ.
 */

type Catalog = Record<string, unknown>;

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];
const PLURAL_RE = new RegExp(`(${PLURAL_SUFFIXES.join('|')})$`);

/** `a.b.item_few` → `a.b.item`, with the value. */
function leaves(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [[prefix, value]];
  }

  return Object.entries(value as Catalog).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function withoutPluralSuffix(path: string): string {
  return path.replace(PLURAL_RE, '');
}

/** Base path → the plural suffixes present for it. */
function pluralForms(catalog: Catalog): Map<string, string[]> {
  const forms = new Map<string, string[]>();

  for (const [path] of leaves(catalog)) {
    const match = PLURAL_RE.exec(path);
    if (!match) continue;
    const base = withoutPluralSuffix(path);
    forms.set(base, [...(forms.get(base) ?? []), match[1]]);
  }

  return forms;
}

/** Interpolation names a message uses, e.g. `{{count}}` → `count`. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

const enLeaves = leaves(en);
const ruLeaves = leaves(ru);

describe('translation catalogs', () => {
  test('both languages cover the same keys, plural forms compared by base', () => {
    // Russian has more plural forms than English for the same key, so the base
    // is what has to match — and each base must appear once per language.
    const base = (entries: Array<[string, unknown]>) =>
      [...new Set(entries.map(([path]) => withoutPluralSuffix(path)))].sort();

    expect(base(ruLeaves)).toEqual(base(enLeaves));
  });

  test('no catalog value is empty', () => {
    const empty = [...enLeaves, ...ruLeaves]
      .filter(([, value]) => typeof value === 'string' && !value.trim())
      .map(([path]) => path);
    expect(empty).toEqual([]);
  });

  test('every plural key carries the forms its language needs', () => {
    // A missing `_few` in Russian silently falls back to English's `_other`.
    // Bases whose count can never be 1 (the bulk delete dialog renders only
    // for N > 1) have no `_one` form — the singular wording would be dead.
    const NO_SINGULAR_BASES = new Set(['transcript.deleteConfirm']);
    const required: Record<'en' | 'ru', string[]> = {
      en: ['_one', '_other'],
      ru: ['_one', '_few', '_many'],
    };

    for (const [language, catalog] of Object.entries({ en, ru }) as Array<['en' | 'ru', Catalog]>) {
      for (const [base, forms] of pluralForms(catalog)) {
        for (const suffix of required[language]) {
          if (suffix === '_one' && NO_SINGULAR_BASES.has(base)) continue;
          expect({ base, language, forms }).toMatchObject({
            forms: expect.arrayContaining([suffix]),
          });
        }
      }
    }
  });

  test('every language has metadata and a catalog', () => {
    // `AppLanguageCode` in `languages.ts` is a literal union; this keeps the
    // RESOURCES keys and LANGUAGE_METADATA entries in step with each other.
    expect(Object.keys(RESOURCES).sort()).toEqual(Object.keys(LANGUAGE_METADATA).sort());
  });

  test('a message and its translation interpolate the same values', () => {
    const ruByPath = new Map(ruLeaves);
    const mismatched = enLeaves
      .filter(([path, value]) => {
        const counterpart = ruByPath.get(path);
        if (typeof value !== 'string' || typeof counterpart !== 'string') return false;
        return placeholders(value).join() !== placeholders(counterpart).join();
      })
      .map(([path]) => path);

    expect(mismatched).toEqual([]);
  });
});
