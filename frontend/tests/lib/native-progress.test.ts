/**
 * Resolution of the coded import/retranscription progress payloads
 * (native-i18n spec D7): Rust adds `code` (+ `params`) beside the English
 * `message`; the frontend renders `importAudio.progress.<code>` /
 * `retranscribe.progress.<code>` and must fall back to the prose, never to
 * a blank or a raw key, whenever the code is unknown or absent.
 *
 * The seam is the pure resolver itself (the same shape `diarizationStageMessage`
 * is tested through): the dialog tests only cover the wiring.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import i18n from '../../src/i18n';
import {
  importProgressText,
  importStageLabel,
  retranscribeProgressText,
  retranscribeStageLabel,
  type NativeProgressPayload,
} from '../../src/lib/native-progress';

// The language switches below mutate the shared i18n singleton; bun runs one
// process per directory batch, so leaving it on `ru` would poison later files
// (the same hazard the dialog suites guard against).
afterEach(async () => {
  await i18n.changeLanguage('en');
});

function progress(fields: Partial<NativeProgressPayload> = {}): NativeProgressPayload {
  return {
    stage: 'transcribing',
    message: 'Fallback prose from Rust',
    ...fields,
  };
}

describe('importProgressText', () => {
  test('resolves a static phase code in English', async () => {
    await i18n.changeLanguage('en');
    expect(importProgressText(progress({ stage: 'decoding', code: 'decoding_file' }))).toBe(
      'Decoding audio file...',
    );
  });

  test('the complete code reuses the existing stage key, not a progress twin', async () => {
    await i18n.changeLanguage('en');
    expect(importProgressText(progress({ stage: 'complete', code: 'complete' }))).toBe(
      'Import complete',
    );
    await i18n.changeLanguage('ru');
    expect(importProgressText(progress({ stage: 'complete', code: 'complete' }))).toBe(
      'Импорт завершён',
    );
  });

  test('unknown and absent codes resolve to null so the caller can fall back to the message', async () => {
    await i18n.changeLanguage('ru');
    expect(importProgressText(progress({ code: 'exploding_audio' }))).toBeNull();
    expect(importProgressText(progress())).toBeNull();
    expect(importProgressText(null)).toBeNull();
  });

  test('the segments-found line pluralizes in Russian (1 / 2–4 / 5+)', async () => {
    await i18n.changeLanguage('ru');
    const line = (found: number) =>
      importProgressText(
        progress({
          stage: 'vad',
          code: 'detecting_segments_progress',
          params: { percent: 40, found },
        }),
      );
    expect(line(1)).toBe('Определение речевых сегментов… 40% (найден 1 сегмент)');
    expect(line(2)).toBe('Определение речевых сегментов… 40% (найдено 2 сегмента)');
    expect(line(5)).toBe('Определение речевых сегментов… 40% (найдено 5 сегментов)');
    expect(line(21)).toBe('Определение речевых сегментов… 40% (найден 21 сегмент)');
  });

  test('the segments-found line stays singular-plural-correct in English too', async () => {
    await i18n.changeLanguage('en');
    expect(
      importProgressText(
        progress({
          stage: 'vad',
          code: 'detecting_segments_progress',
          params: { percent: 40, found: 1 },
        }),
      ),
    ).toBe('Detecting speech segments... 40% (1 found)');
  });

  test('the per-segment line renders the duration with the locale decimal separator', async () => {
    const payload = progress({
      code: 'transcribing_segment',
      params: { current: 2, total: 5, duration_sec: 1.2 },
    });
    await i18n.changeLanguage('ru');
    expect(importProgressText(payload)).toBe('Транскрибация: сегмент 2 из 5 (1,2 с)…');
    await i18n.changeLanguage('en');
    expect(importProgressText(payload)).toBe('Transcribing segment 2 of 5 (1.2s)...');
  });

  test('params without a code are inert', async () => {
    await i18n.changeLanguage('en');
    expect(
      importProgressText(progress({ params: { percent: 50 } })),
    ).toBeNull();
  });
});

describe('retranscribeProgressText', () => {
  test('resolves codes in its own namespace', async () => {
    await i18n.changeLanguage('en');
    expect(retranscribeProgressText(progress({ stage: 'saving', code: 'saving_transcripts' }))).toBe(
      'Saving transcripts...',
    );
    await i18n.changeLanguage('ru');
    expect(retranscribeProgressText(progress({ stage: 'saving', code: 'saving_transcripts' }))).toBe(
      'Сохранение транскрипций…',
    );
  });

  test('the complete code reuses retranscribe.stages.complete', async () => {
    await i18n.changeLanguage('en');
    expect(retranscribeProgressText(progress({ stage: 'complete', code: 'complete' }))).toBe(
      'Retranscription complete',
    );
  });

  test('an import-only code does not resolve here', async () => {
    await i18n.changeLanguage('en');
    // `creating_folder` exists only under importAudio.progress; the
    // retranscription resolver must fall back rather than cross namespaces.
    expect(retranscribeProgressText(progress({ stage: 'copying', code: 'creating_folder' }))).toBeNull();
  });
});

describe('stage captions', () => {
  test('known native stages read as words, not snake_case tokens', async () => {
    await i18n.changeLanguage('en');
    expect(importStageLabel('vad')).toBe('Detecting speech');
    expect(importStageLabel('resampling')).toBe('Converting');
    expect(retranscribeStageLabel('transcribing')).toBe('Transcribing');
    await i18n.changeLanguage('ru');
    expect(importStageLabel('saving')).toBe('Сохранение');
    expect(retranscribeStageLabel('decoding')).toBe('Декодирование');
  });

  test('an unseen stage token stays raw rather than going blank', async () => {
    await i18n.changeLanguage('ru');
    expect(importStageLabel('quantum_leap')).toBe('quantum_leap');
    expect(retranscribeStageLabel('quantum_leap')).toBe('quantum_leap');
  });
});
