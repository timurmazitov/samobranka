/**
 * The BlockNote dictionary mapper (native-i18n): the summary editor's menus,
 * slash menu, and tooltips follow the app UI language. `en` and `ru` are the
 * only UI languages (src/i18n/languages.ts); anything else falls back to
 * English with the same primary-subtag rule as normalizeAppLanguage.
 */
import { describe, expect, test } from 'bun:test';

import { en, ru } from '@blocknote/core/locales';
import { blocknoteDictionary, blocknoteDictionaryFor } from '../../src/lib/blocknote-i18n';

describe('blocknoteDictionary', () => {
  test('Russian tags resolve the shipped Russian dictionary', () => {
    for (const tag of ['ru', 'ru-RU', 'ru_RU', 'RU', 'ru-RU', 'ru-UA']) {
      expect(blocknoteDictionary(tag)).toBe(ru);
    }
  });

  test('English and unknown tags fall back to English', () => {
    for (const tag of ['en', 'en-GB', 'de', 'xx-YY', '']) {
      expect(blocknoteDictionary(tag)).toBe(en);
    }
  });

  test('the Russian dictionary is really localized (pin one upstream label)', () => {
    // Guards against the upstream locale file disappearing or being renamed:
    // the slash-menu heading entry is Russian in ru and English in en.
    expect(ru.slash_menu.heading.title).not.toBe(en.slash_menu.heading.title);
    expect(blocknoteDictionary('ru')).not.toBe(blocknoteDictionary('en'));
  });
});

describe('blocknoteDictionaryFor', () => {
  test('uses the live i18next language', () => {
    expect(blocknoteDictionaryFor({ language: 'ru' })).toBe(ru);
    expect(blocknoteDictionaryFor({ language: 'en' })).toBe(en);
  });
});
