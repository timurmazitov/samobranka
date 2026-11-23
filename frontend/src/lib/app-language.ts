import { isAppLanguage, type AppLanguageCode } from '@/i18n';

/**
 * Where the interface language is persisted.
 *
 * `preferences.json` through `@tauri-apps/plugin-store`, the same file the
 * recording-notification preference uses. A real file in the app config
 * directory (not webview `localStorage`) so the Rust side can read the active
 * language when the tray and notifications are localized later.
 *
 * The store is loaded lazily: this module is imported from the client only, but
 * the import stays dynamic so nothing touches Tauri during the static-export
 * prerender.
 */

const STORE_FILE = 'preferences.json';
const SETTING_KEY = 'app_language';

/**
 * The event `LanguageProvider.setLanguage` emits on every language switch so
 * the Rust side updates its managed interface language without a restart
 * (native-i18n spec D4). The payload is the bare language code. The Rust
 * listener subscribes under the same literal, pinned by
 * `tests/lib/app-language-parity.test.ts` against
 * `l10n::language::LANGUAGE_CHANGED_EVENT`.
 */
export const APP_LANGUAGE_CHANGED_EVENT = 'app-language-changed';

async function openStore() {
  const { Store } = await import('@tauri-apps/plugin-store');
  return Store.load(STORE_FILE);
}

/** The stored language, or `null` when the user has never chosen one. */
export async function loadAppLanguage(): Promise<AppLanguageCode | null> {
  try {
    const store = await openStore();
    const stored = await store.get<unknown>(SETTING_KEY);
    return isAppLanguage(stored) ? stored : null;
  } catch (error) {
    console.error('Failed to load app language preference:', error);
    return null;
  }
}

export async function saveAppLanguage(language: AppLanguageCode): Promise<void> {
  const store = await openStore();
  await store.set(SETTING_KEY, language);
  await store.save();
}
