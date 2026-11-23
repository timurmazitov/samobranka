import { en, ru, type Dictionary } from '@blocknote/core/locales';
import type { i18n as I18nInstance } from 'i18next';

/**
 * Bridges the app UI language to BlockNote's built-in dictionaries
 * (native-i18n): the summary editor is BlockNote, and its menus, slash menu,
 * and formatting tooltips are drawn by BlockNote from its own dictionary.
 *
 * BlockNote ships a dictionary per locale (`@blocknote/core/locales`); the
 * app UI offers exactly `en` and `ru` (see `src/i18n/languages.ts`), and both
 * are available upstream, so the mapping is a primary-subtag lookup with
 * English as the fallback — the same rule as `l10n::normalize` on the Rust
 * side and `normalizeAppLanguage` on the frontend. When the UI language
 * changes, callers remount the editor (keyed by the language) so the new
 * dictionary takes effect: BlockNote 0.36 fixes the dictionary at editor
 * creation time.
 */

/** Map an i18next language tag to a BlockNote dictionary. Unknown -> English. */
export function blocknoteDictionary(language: string): Dictionary {
  const primary = language.toLowerCase().replace(/_/g, '-').split('-')[0];
  return primary === 'ru' ? ru : en;
}

/** Dictionary for the current i18next language of the given instance. */
export function blocknoteDictionaryFor(i18n: Pick<I18nInstance, 'language'>): Dictionary {
  return blocknoteDictionary(i18n.language);
}
