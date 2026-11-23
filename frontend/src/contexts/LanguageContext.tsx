'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import i18n, {
  DEFAULT_LANGUAGE,
  resolveAppLanguage,
  systemLocale,
  type AppLanguageCode,
} from '@/i18n';
import { applyWindowTitle } from '@/lib/app-window-title';
import {
  APP_LANGUAGE_CHANGED_EVENT,
  loadAppLanguage,
  saveAppLanguage,
} from '@/lib/app-language';

interface LanguageContextValue {
  language: AppLanguageCode;
  /** False until the stored preference (or the OS locale) has been resolved. */
  ready: boolean;
  setLanguage: (language: AppLanguageCode) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguageCode>(DEFAULT_LANGUAGE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const resolve = async () => {
      // A stored choice always wins. Without one, first run follows the OS
      // locale — `navigator.language` because tauri-plugin-os has no Rust half
      // installed in this app. `resolveAppLanguage` is the one frontend
      // algorithm; its Rust twin in `l10n/language.rs` is pinned to the same
      // case vector by `tests/lib/app-language-parity.test.ts`.
      const next = resolveAppLanguage(await loadAppLanguage(), systemLocale());
      if (cancelled) return;

      if (i18n.language !== next) {
        await i18n.changeLanguage(next);
      }
      setLanguageState(next);
      setReady(true);
    };

    resolve();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the document language in step with the interface language, for
  // hyphenation, spell-check and assistive technology.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
    }
  }, [language]);

  // Keep the window/document title in step with the interface language
  // (spec decision 7). `src/app/metadata.ts` stays English as the
  // build-time fallback; the live title is re-read from the catalog on
  // every switch so future titles localize with no further wiring.
  useEffect(() => {
    void applyWindowTitle(i18n.t('app.title'));
  }, [language]);

  const setLanguage = useCallback(async (next: AppLanguageCode) => {
    if (i18n.language !== next) {
      await i18n.changeLanguage(next);
    }
    setLanguageState(next);
    try {
      await saveAppLanguage(next);
    } catch (error) {
      // The switch itself already happened; a failed write only means the
      // choice will not survive a restart.
      console.error('Failed to save app language preference:', error);
    }
    // Tell the Rust side (native-i18n spec D4): the listener updates the
    // managed language so the native surfaces re-localize without a restart.
    // Sent even when the store write failed — the switch happened, so the
    // live state must follow the UI regardless of persistence. Guarded on the
    // injected Tauri internals and dynamically imported so the statically
    // exported browser build never touches Tauri APIs (same pattern as
    // `src/lib/app-window-title.ts`).
    if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
      try {
        const { emit } = await import('@tauri-apps/api/event');
        await emit(APP_LANGUAGE_CHANGED_EVENT, next);
      } catch (error) {
        // Without the native side the UI is still fully switched; only Rust
        // surfaces keep their previous language until the next start.
        console.error('Failed to notify the native side about the language change:', error);
      }
    }
  }, []);

  const value = useMemo(
    () => ({ language, ready, setLanguage }),
    [language, ready, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useAppLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useAppLanguage must be used within a LanguageProvider');
  }
  return context;
}

/**
 * Renders its children once the interface language is known.
 *
 * The statically exported HTML is prerendered with the language provider's
 * default, so anything rendered before the stored preference is read can only
 * be in the wrong language. Holding the app back for the few milliseconds the
 * preference takes to load avoids both a flash of English and a hydration
 * mismatch.
 */
export function AppLanguageGate({ children }: { children: ReactNode }) {
  const { ready } = useAppLanguage();
  if (!ready) {
    return <div className="min-h-screen w-full" aria-busy="true" />;
  }
  return <>{children}</>;
}
