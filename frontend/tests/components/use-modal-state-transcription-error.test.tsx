/**
 * The global transcription-error listener resolves the payload's `code`
 * through the frontend catalog and falls back to `userMessage` when the code
 * is unknown or absent (native-i18n spec D7, ticket 05).
 *
 * Behaviour keys (`actionable` → model selector, else toast; the listener
 * itself in RecordingControls keys off `phase`) must stay untouched — these
 * tests pin both the language choice and the untouched branching.
 *
 * Mirrors the ticket-06 harness: Tauri events and sonner are mocked with an
 * `afterAll` restore, and a probe component drives the hook.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import i18n from '../../src/i18n';

const modules = ['@tauri-apps/api/event', 'sonner'];
const originals = await Promise.all(
  modules.map(async path => [path, { ...(await import(path)) }] as const),
);
afterAll(() => {
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

type Handler = (event: { payload: Record<string, unknown> }) => void;
const registered = new Map<string, Handler>();
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  },
}));

interface ToastCall {
  title: string;
  options?: { description?: string };
}
const toastCalls: ToastCall[] = [];
mock.module('sonner', () => ({
  toast: {
    error: (title: string, options?: { description?: string }) => {
      toastCalls.push({ title, options });
    },
    info: () => {},
    success: () => {},
    warning: () => {},
  },
}));

const { useModalState } = await import('../../src/hooks/useModalState');

interface HookState {
  modals: { modelSelector: boolean; errorAlert: boolean };
  messages: { modelSelector: string };
}
let latest: HookState | undefined;

function Probe() {
  latest = useModalState();
  return null;
}

let renderer: ReactTestRenderer | undefined;

async function emitTauri(name: string, payload: Record<string, unknown>) {
  const handler = registered.get(name);
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload });
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(async () => {
  registered.clear();
  toastCalls.length = 0;
  latest = undefined;
  await i18n.changeLanguage('en');
  await act(async () => {
    renderer = create(<Probe />);
  });
  for (let attempt = 0; attempt < 60 && !registered.has('transcription-error'); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  expect(registered.has('transcription-error')).toBe(true);
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer!.unmount();
    });
  }
  renderer = undefined;
  await i18n.changeLanguage('en');
});

describe('useModalState transcription-error listener', () => {
  test('a non-actionable coded error toasts the Russian catalog sentence', async () => {
    await i18n.changeLanguage('ru');
    await emitTauri('transcription-error', {
      error: 'Transcribe.cpp model \'m\' is not downloaded. Download it in Settings → Transcript Model → Transcribe.cpp models.',
      userMessage: 'Recording cannot start: RAW-ENGLISH-PROSE',
      actionable: false,
      phase: 'startup',
      code: 'transcription.model_not_downloaded',
      params: { model: 'parakeet-ultra-Q8_0' },
    });
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].options?.description).toContain('Модель Transcribe.cpp');
    expect(toastCalls[0].options?.description).toContain('parakeet-ultra-Q8_0');
    expect(toastCalls[0].options?.description).not.toContain('RAW-ENGLISH-PROSE');
    // Behaviour untouched: a non-actionable error opens no modal.
    expect(latest?.modals.modelSelector).toBeFalsy();
  });

  test('an unknown code toasts the English prose, never blank', async () => {
    await i18n.changeLanguage('ru');
    await emitTauri('transcription-error', {
      error: 'boom',
      userMessage: 'FUTURE-NATIVE-PROSE',
      actionable: false,
      phase: 'active',
      code: 'transcription.exploding_audio',
    });
    expect(toastCalls).toHaveLength(1);
    expect(toastCalls[0].options?.description).toBe('FUTURE-NATIVE-PROSE');
  });

  test('an actionable coded error opens the model selector with the Russian sentence', async () => {
    await i18n.changeLanguage('ru');
    await emitTauri('transcription-error', {
      error: 'Failed to discover transcribe.cpp models: io',
      userMessage: 'Recording failed: Unable to initialize speech recognition.',
      actionable: true,
      phase: 'active',
      code: 'transcription.model_discovery_failed',
      params: { detail: 'io' },
    });
    expect(latest?.modals.modelSelector).toBe(true);
    expect(latest?.messages.modelSelector).toContain('Не удалось найти модели Transcribe.cpp');
    expect(latest?.messages.modelSelector).toContain('io');
    // Actionable errors go to the modal, not the toast.
    expect(toastCalls).toHaveLength(0);
  });
});
