/**
 * Microphone hot-swap toasts render from the catalogs (native-i18n ticket 09).
 *
 * Seam: mount the real RecordingStateProvider with the Tauri event bus mocked
 * (same pattern as recording-state-shutdown.test.tsx), fire the mic events the
 * Rust backend emits, and assert the sonner toast receives the catalog message
 * for the active language — English for `en`, Russian for `ru`, with the raw
 * Rust error tail kept verbatim in the fallback toast. Expected strings are
 * built from the catalog JSON with manual `{{param}}` substitution, not from
 * `i18n.t`, so code and catalogs must agree.
 */

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';

const originalCore = { ...await import('@tauri-apps/api/core') };
const originalEvents = { ...await import('@tauri-apps/api/event') };
const originalSonner = { ...await import('sonner') };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/api/event', () => originalEvents);
  mock.module('sonner', () => originalSonner);
});

type ToastCall = { method: 'info' | 'error'; message: string };
let toastCalls: ToastCall[] = [];
const handlers = new Map<string, (event: { payload: any }) => void>();

mock.module('@tauri-apps/api/core', () => ({
  invoke: async () => ({
    is_recording: false, is_paused: false, is_active: false,
    recording_duration: null, active_duration: null,
  }),
}));
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: any }) => void) => {
    handlers.set(name, handler);
    return () => { handlers.delete(name); };
  },
}));
mock.module('sonner', () => ({
  toast: Object.assign(() => {}, {
    success: () => {},
    info: (message: string) => { toastCalls.push({ method: 'info', message }); },
    error: (message: string) => { toastCalls.push({ method: 'error', message }); },
    warning: () => {},
  }),
}));

const { RecordingStateProvider } = await import('../../src/contexts/RecordingStateContext');
const { default: i18n } = await import('../../src/i18n');

/** `catalog.recording.key` with `{{name}}` placeholders filled manually. */
function catalogMessage(catalog: typeof en | typeof ru, key: string, params: Record<string, string>): string {
  const value = (catalog.recording as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`catalog key recording.${key} is missing`);
  return Object.entries(params).reduce(
    (text, [name, replacement]) => text.replaceAll(`{{${name}}}`, replacement),
    value,
  );
}

let view: ReactTestRenderer | undefined;
afterEach(async () => {
  if (view) await act(async () => { view!.unmount(); });
  view = undefined;
  handlers.clear();
  toastCalls = [];
  await act(async () => { await i18n.changeLanguage('en'); });
});

async function mountProvider(): Promise<void> {
  await act(async () => {
    view = create(<RecordingStateProvider><span /></RecordingStateProvider>);
  });
}

/** Fire a captured event handler the way the Tauri event bus would. */
async function fire(event: string, payload: any): Promise<void> {
  const handler = handlers.get(event);
  expect(handler, `listener for ${event} was never registered`).toBeDefined();
  // The mic callbacks are async (device-label resolution); let them settle.
  await act(async () => { handler!({ payload }); });
  await act(async () => {});
}

const catalogs = { en, ru } as const;

describe('microphone hot-swap toasts', () => {
  for (const language of ['en', 'ru'] as const) {
    test(`all four mic events toast in ${language.toUpperCase()}`, async () => {
      await act(async () => { await i18n.changeLanguage(language); });
      const catalog = catalogs[language];
      await mountProvider();

      // mic-device-switched: no isRecording gate (also fires at start fallback).
      await fire('mic-device-switched', { device_name: 'mic-1', device_label: 'Mic A' });
      expect(toastCalls).toEqual([
        { method: 'info', message: catalogMessage(catalog, 'micSwitched', { label: 'Mic A' }) },
      ]);
      toastCalls = [];

      // The remaining two failure toasts are gated on an active recording.
      await fire('recording-started', {});

      // mic-swap-failed: the Rust `error` tail must stay raw (spec D7).
      const rawRustError = 'Os { code: -1, message: "device busy" }';
      await fire('mic-swap-failed', {
        error: rawRustError,
        device_name: 'mic-1',
        device_label: 'Mic A',
      });
      expect(toastCalls).toEqual([
        {
          method: 'error',
          message: catalogMessage(catalog, 'micFallbackFailed', { label: 'Mic A', error: rawRustError }),
        },
      ]);
      toastCalls = [];

      await fire('mic-unavailable', {});
      expect(toastCalls).toEqual([
        { method: 'error', message: catalogMessage(catalog, 'micUnavailable', {}) },
      ]);
      toastCalls = [];

      await fire('mic-recovery-exhausted', { device_name: 'mic-1', device_label: 'Mic B' });
      expect(toastCalls).toEqual([
        { method: 'error', message: catalogMessage(catalog, 'micRecoveryExhausted', { label: 'Mic B' }) },
      ]);
    });
  }

  test('the Russian toasts do not leak the English originals', async () => {
    await act(async () => { await i18n.changeLanguage('ru'); });
    await mountProvider();
    await fire('mic-device-switched', { device_name: 'mic-1', device_label: 'Mic A' });
    await fire('recording-started', {});
    await fire('mic-swap-failed', { error: 'boom', device_name: 'mic-1', device_label: 'Mic A' });
    await fire('mic-unavailable', {});
    await fire('mic-recovery-exhausted', { device_name: 'mic-1', device_label: 'Mic B' });
    const messages = toastCalls.map(call => call.message).join('\n');
    expect(messages).not.toContain('Microphone switched to');
    expect(messages).not.toContain('Microphone fallback failed');
    expect(messages).not.toContain('No microphone available');
    expect(messages).not.toContain('could not be recovered');
  });
});
