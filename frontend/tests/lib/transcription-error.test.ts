/**
 * Resolution of the coded `transcription-error` payloads (native-i18n spec
 * D7, ticket 05): Rust adds `code` (+ `params`) beside the English
 * `userMessage`; the listeners render `transcription.errors.<code>` and must
 * fall back to the prose, never to a blank or a raw key, whenever the code is
 * unknown or absent.
 *
 * The seam is the pure resolver itself (the same shape `native-progress`
 * pins); the hook wiring is covered in tests/components.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import i18n from '../../src/i18n';
import {
  transcriptionErrorText,
  type TranscriptionErrorPayloadLike,
} from '../../src/lib/transcription-error';

// The language switches mutate the shared i18n singleton; bun runs one
// process per directory batch, so leaving it on `ru` would poison later
// files (the same hazard the native-progress suite guards against).
afterEach(async () => {
  await i18n.changeLanguage('en');
});

function payload(fields: Partial<TranscriptionErrorPayloadLike> = {}): TranscriptionErrorPayloadLike {
  return {
    error: 'RAW-NATIVE-DETAIL',
    userMessage: 'Fallback prose from Rust',
    ...fields,
  };
}

describe('transcriptionErrorText', () => {
  test('resolves a code in English', async () => {
    await i18n.changeLanguage('en');
    expect(
      transcriptionErrorText(payload({ code: 'transcription.provider_not_loaded' })),
    ).toBe('No transcription model is loaded.');
  });

  test('resolves the model-not-ready family in Russian with interpolated values', async () => {
    await i18n.changeLanguage('ru');
    expect(
      transcriptionErrorText(
        payload({
          code: 'transcription.model_downloading',
          params: { model: 'parakeet-ultra-Q8_0', percent: 42 },
        }),
      ),
    ).toBe(
      'Модель Transcribe.cpp «parakeet-ultra-Q8_0» ещё загружается (42%). Требуется дождаться завершения загрузки.',
    );
    expect(
      transcriptionErrorText(
        payload({
          code: 'transcription.model_errored',
          params: { model: 'gigaam-v3-ctc-Q8_0', detail: 'bad gguf magic' },
        }),
      ),
    ).toBe(
      'Модель Transcribe.cpp «gigaam-v3-ctc-Q8_0» завершилась с ошибкой: bad gguf magic. Необходимо скачать её заново в Настройках.',
    );
  });

  test('resolves the language-unsupported code with the language tag', async () => {
    await i18n.changeLanguage('ru');
    expect(
      transcriptionErrorText(
        payload({ code: 'transcription.language_unsupported', params: { language: 'de' } }),
      ),
    ).toContain('de');
  });

  test('an unknown code falls back to the English prose, never blank', async () => {
    await i18n.changeLanguage('ru');
    expect(transcriptionErrorText(payload({ code: 'transcription.exploding_audio' }))).toBe(
      'Fallback prose from Rust',
    );
  });

  test('an absent code falls back to the English prose', async () => {
    await i18n.changeLanguage('ru');
    expect(transcriptionErrorText(payload())).toBe('Fallback prose from Rust');
  });

  test('a null code (Rust Option::None) falls back to the English prose', async () => {
    await i18n.changeLanguage('ru');
    expect(transcriptionErrorText(payload({ code: null }))).toBe('Fallback prose from Rust');
  });

  test('the resolved sentence is never empty even with an empty prose', async () => {
    await i18n.changeLanguage('ru');
    // An unknown code AND empty prose must not produce a blank toast: the
    // `error` field is the last diagnostic resort.
    expect(transcriptionErrorText(payload({ userMessage: '', code: 'nope' }))).toBe(
      'RAW-NATIVE-DETAIL',
    );
  });
});
