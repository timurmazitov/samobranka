import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const originalEvents = { ...await import('@tauri-apps/api/event') };
const originalWindow = { ...await import('@tauri-apps/api/window') };
const originalAppLanguage = { ...await import('../../src/lib/app-language') };
afterAll(() => {
  // bun's mock.module leaks across files in one process; restore the module
  // registries the way the other Tauri-touching tests do, and drop the fake
  // window so later files keep their own Tauri-presence assumption.
  mock.module('@tauri-apps/api/event', () => originalEvents);
  mock.module('@tauri-apps/api/window', () => originalWindow);
  mock.module('../../src/lib/app-language', () => originalAppLanguage);
  delete (globalThis as Record<string, unknown>).window;
});

/**
 * Every language switch tells Rust (native-i18n ticket 02, spec D4):
 * `LanguageContext.setLanguage` emits `app-language-changed` with the bare
 * code so the listener can update the managed language state — the native
 * surfaces (tray from ticket 03) re-localize without a restart.
 *
 * Modeled on `language-window-title.test.tsx`: the provider is driven through
 * its public context API and the Tauri boundary is mocked. The `emit` mock
 * also pins the payload shape the Rust listener parses (a bare string).
 */

// bun test has no DOM; stub the pieces the provider and the title helper touch.
// `__TAURI_INTERNALS__` marks the app as running under Tauri, which is what
// the emit guard in `setLanguage` checks before importing the event API.
(globalThis as Record<string, unknown>).document = {
  title: '',
  documentElement: {},
};
(globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };

const emit = mock(async (_event: string, _payload: unknown) => {});
mock.module('@tauri-apps/api/event', () => ({ emit }));
// The provider's title effect also reaches for the window API once Tauri is
// flagged present; stub it so the test observes only the emit.
mock.module('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setTitle: async (_title: string) => {} }),
}));

// One mock for the whole file (mid-file re-mock would not reach the
// already-imported provider); the flag switches the save path to failure for
// the test that needs it.
let saveShouldFail = false;
mock.module('../../src/lib/app-language', () => ({
  // The bridge's own storage is covered by the parity test; here the provider
  // must not need the Tauri store to emit.
  loadAppLanguage: async () => null,
  saveAppLanguage: async () => {
    if (saveShouldFail) throw new Error('store unavailable');
  },
  APP_LANGUAGE_CHANGED_EVENT: 'app-language-changed',
}));

const i18n = (await import('../../src/i18n')).default;
const { LanguageProvider, useAppLanguage } = await import('../../src/contexts/LanguageContext');

type SetLanguage = (language: 'en' | 'ru') => Promise<void>;
let setLanguageRef: SetLanguage | undefined;
let renderer: ReactTestRenderer | undefined;

function LanguageProbe(): null {
  const { setLanguage } = useAppLanguage();
  setLanguageRef = setLanguage;
  return null;
}

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  setLanguageRef = undefined;
  emit.mockClear();
  (globalThis.document as { title: string }).title = '';
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

test('setLanguage emits app-language-changed with the bare code', async () => {
  await renderProvider();

  await act(async () => {
    await setLanguageRef!('ru');
  });
  expect(emit).toHaveBeenCalledWith('app-language-changed', 'ru');

  await act(async () => {
    await setLanguageRef!('en');
  });
  expect(emit).toHaveBeenLastCalledWith('app-language-changed', 'en');
});

test('a failed store save still notifies Rust — the switch itself happened', async () => {
  // The managed language must follow the UI even when persisting fails; a
  // stale Rust value until the next restart is the accepted trade (the switch
  // is done, the disk write is not).
  saveShouldFail = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    await renderProvider();
    await act(async () => {
      await setLanguageRef!('ru');
    });
  } finally {
    console.error = originalError;
    saveShouldFail = false;
  }
  expect(emit).toHaveBeenCalledWith('app-language-changed', 'ru');
});
