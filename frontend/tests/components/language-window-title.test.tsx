import { afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

/**
 * The window title follows the active interface language (spec decision 7,
 * audit BUG-2): `LanguageProvider` re-applies the translated `app.title` on
 * mount and on every language switch.
 *
 * The brand is deliberately identical in both locales, so the mechanism (not
 * the constant) is observed through a sentinel override of the Russian
 * `app.title` for the duration of the test.
 */

// bun test has no DOM; stub the pieces the provider and the title helper touch.
(globalThis as Record<string, unknown>).document = {
  title: '',
  documentElement: {},
};

const RU_TITLE = 'app-title-ru-under-test';

mock.module('../../src/lib/app-language', () => ({
  // No stored preference: the provider resolves from the OS locale (absent
  // under bun, so English) without touching the Tauri store.
  loadAppLanguage: async () => null,
  saveAppLanguage: async () => {},
  APP_LANGUAGE_CHANGED_EVENT: 'app-language-changed',
}));

const i18n = (await import('../../src/i18n')).default;
const en = (await import('../../src/i18n/locales/en/translation.json')).default;
const ru = (await import('../../src/i18n/locales/ru/translation.json')).default;
const EN_TITLE = en.app.title;
const RU_TITLE_ORIGINAL = ru.app.title;
const { LanguageProvider, useAppLanguage } = await import('../../src/contexts/LanguageContext');

type SetLanguage = (language: 'en' | 'ru') => Promise<void>;
let setLanguageRef: SetLanguage | undefined;

// Captures the provider's `setLanguage` so the test drives a switch through
// the public context API, the same way the settings selector does.
function LanguageProbe(): null {
  const { setLanguage } = useAppLanguage();
  setLanguageRef = setLanguage;
  return null;
}

let renderer: ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  setLanguageRef = undefined;
  (globalThis.document as { title: string }).title = '';
  ru.app.title = RU_TITLE_ORIGINAL;
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

async function renderProvider() {
  await act(async () => {
    renderer = create(
      <LanguageProvider>
        <LanguageProbe />
      </LanguageProvider>,
    );
  });
}

test('the document title starts from the active language', async () => {
  await renderProvider();
  expect(document.title).toBe(EN_TITLE);
});

test('switching the language re-applies the window title in both directions', async () => {
  // A sentinel Russian title proves the title is re-read from the catalog on
  // every switch rather than captured once. The JSON catalogs are the live
  // resource store, so the override takes effect for i18next.
  ru.app.title = RU_TITLE;
  await renderProvider();

  await act(async () => {
    await setLanguageRef!('ru');
  });
  expect(document.title).toBe(RU_TITLE);

  await act(async () => {
    await setLanguageRef!('en');
  });
  expect(document.title).toBe(EN_TITLE);
});
