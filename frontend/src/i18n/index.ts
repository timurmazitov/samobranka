import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { LANGUAGE_METADATA, languageOptionLabel, type AppLanguageCode } from './languages';
import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

/**
 * Interface localization.
 *
 * Two languages, English and Russian, one catalog each. The catalogs are
 * imported statically (this is a Next.js static export, so Vite-style glob
 * imports from the reference implementation are not available).
 *
 * Date, number and unit formatting follow the same language; see
 * `src/lib/format-locale.ts`.
 */

export const RESOURCES = {
  en: { translation: en },
  ru: { translation: ru },
} as const;

// The union lives in `./languages` (see its note); re-exported so existing
// `@/i18n` consumers keep working. RESOURCES keys and the union are checked
// against each other by `tests/lib/i18n-parity.test.ts`.
export type { AppLanguageCode };

export const DEFAULT_LANGUAGE: AppLanguageCode = 'en';

export const SUPPORTED_LANGUAGES = (
  Object.keys(RESOURCES) as AppLanguageCode[]
)
  .map((code) => ({
    code,
    ...LANGUAGE_METADATA[code],
    label: languageOptionLabel(LANGUAGE_METADATA[code]),
  }))
  .sort((a, b) => a.priority - b.priority);

export function isAppLanguage(value: unknown): value is AppLanguageCode {
  return typeof value === 'string' && value in RESOURCES;
}

/**
 * Maps an arbitrary locale tag (`ru-RU`, `ru_RU`, `en-GB`) onto a supported
 * language. Anything whose primary subtag is not Russian falls back to English.
 */
export function normalizeAppLanguage(tag: string | null | undefined): AppLanguageCode {
  if (!tag) return DEFAULT_LANGUAGE;
  const primary = tag.toLowerCase().replace(/_/g, '-').split('-')[0];
  return isAppLanguage(primary) ? primary : DEFAULT_LANGUAGE;
}

/**
 * The full startup resolution: a stored choice wins over the OS locale in
 * both directions; with no usable stored value the OS locale decides through
 * `normalizeAppLanguage`, and English decides when neither is available.
 *
 * The Rust side reproduces this order in
 * `frontend/src-tauri/src/l10n/language.rs::resolve_language`; both sides are
 * held to the shared case vector in that file by
 * `tests/lib/app-language-parity.test.ts`. A stored value only counts when it
 * is an exact supported code — `isAppLanguage` is case-sensitive — so a
 * hand-edited `"RU"` falls through to the OS locale instead of erroring.
 */
export function resolveAppLanguage(
  stored: string | null | undefined,
  osLocale: string | null | undefined,
): AppLanguageCode {
  if (isAppLanguage(stored)) return stored;
  return normalizeAppLanguage(osLocale);
}

/** The OS locale as the webview reports it, or null when unavailable. */
export function systemLocale(): string | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.language || navigator.languages?.[0] || null;
}

i18n.use(initReactI18next).init({
  resources: RESOURCES,
  // Deterministic during the static-export prerender; the provider switches to
  // the stored preference after mount.
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: Object.keys(RESOURCES),
  interpolation: {
    // React escapes values already.
    escapeValue: false,
  },
  react: {
    // Static export: never suspend.
    useSuspense: false,
  },
  returnNull: false,
});

export default i18n;
