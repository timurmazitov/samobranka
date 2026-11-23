/**
 * Provider-independent diarization seam.
 *
 * The decision "can this meeting be diarized" lives in native code (installed
 * Nemotron model + audio.cpp runtime + no active recording). The frontend has
 * no provider gate: the same command is called for Whisper, Parakeet and
 * audioCpp, and the returned status drives the UI.
 *
 * The Tauri bridge is not mocked at module scope here: mocking a Tauri module
 * leaks into other test files in the same bun process. The client seam is
 * injected instead, which is exactly what the stop flow uses.
 */

import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AUDIOCPP_DIARIZE_COMMAND,
  DIARIZATION_DEFERRED_MESSAGE,
  DIARIZATION_FAILED_MESSAGE,
  DIARIZATION_NO_MODEL_MESSAGE,
  DIARIZATION_NO_RUNTIME_MESSAGE,
  DIARIZATION_PROGRESS_EVENT,
  DIARIZATION_STAGES,
  DIARIZATION_UNAVAILABLE_HINT,
  DIARIZATION_BAND_START,
  SPEAKER_NAMES_RESET_EVENT,
  SPEAKER_NAMES_RESET_HINT,
  TRANSCRIPT_UPDATED_EVENT,
  TauriDiarizationClient,
  diarizationStatusMessage,
  hasInstalledDiarizationModel,
  shouldToastDiarizationStatus,
  shouldToastDiarizationUnavailable,
  showDiarizationFailure,
  startLiveDiarization,
  type DiarizationClient,
  type DiarizationResult,
  type DiarizationStatus,
} from '../../src/lib/diarization';

function client(result: DiarizationResult | Error) {
  const diarizeMeeting = mock(async (_meetingId: string) => {
    if (result instanceof Error) throw result;
    return result;
  });
  const instance: DiarizationClient = { diarizeMeeting };
  return { instance, diarizeMeeting };
}

function resultFor(status: DiarizationStatus): DiarizationResult {
  return {
    meeting_id: 'meeting-42',
    status,
    labeled_segments: status === 'ran' ? 3 : 0,
    total_segments: 3,
    speakers_available: status === 'ran',
    error: status === 'failed' ? 'engine exploded' : null,
  };
}

describe('startLiveDiarization', () => {
  /** Minimal toast seam: only `error` is reachable from an automatic pass. */
  function recorder() {
    const error = mock((_message: string, _options?: { description?: string }) => {});
    return {
      toast: { error },
      error,
    };
  }

  test('calls the same command with the same arguments for every transcription provider', async () => {
    // The seam takes no provider at all; the loop documents that the three
    // providers a meeting can originate from now behave identically.
    for (const _provider of ['localWhisper', 'parakeet', 'audioCpp']) {
      const calls: Array<[string, Record<string, unknown>]> = [];
      const client = new TauriDiarizationClient(async (command, args) => {
        calls.push([command, args]);
        return resultFor('ran');
      });
      const { toast } = recorder();

      await startLiveDiarization(client, 'meeting-42', toast);

      expect(AUDIOCPP_DIARIZE_COMMAND).toBe('audiocpp_diarize_meeting');
      expect(calls).toEqual([[AUDIOCPP_DIARIZE_COMMAND, { meetingId: 'meeting-42' }]]);
    }
  });

  test('runs the pass once for the saved meeting and stays quiet', async () => {
    const { instance, diarizeMeeting } = client(resultFor('ran'));
    const { toast, error } = recorder();

    await startLiveDiarization(instance, 'meeting-42', toast);

    expect(diarizeMeeting).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting).toHaveBeenCalledWith('meeting-42');
    expect(error).not.toHaveBeenCalled();
  });

  test('only a failed pass interrupts the user, and explains it with the mirrored text', async () => {
    const expected: Array<[DiarizationStatus, boolean]> = [
      ['ran', false],
      ['no_model', false],
      ['no_runtime', false],
      ['deferred', false],
      ['failed', true],
    ];

    for (const [status, speaks] of expected) {
      const { instance } = client(resultFor(status));
      const { toast, error } = recorder();

      await startLiveDiarization(instance, 'meeting-42', toast);

      expect(error).toHaveBeenCalledTimes(speaks ? 1 : 0);
      if (speaks) {
        expect(error).toHaveBeenCalledWith('Diarization failed', {
          description: DIARIZATION_FAILED_MESSAGE,
        });
      }
    }
  });

  test('a rejected pass leaves the saved meeting alone: it resolves and stays quiet', async () => {
    const { instance, diarizeMeeting } = client(new Error('native library missing'));
    const { toast, error } = recorder();

    // Must not reject: the stop flow's outer error path would mark the saved
    // meeting as failed.
    await expect(
      startLiveDiarization(instance, 'meeting-42', toast),
    ).resolves.toBeUndefined();

    expect(diarizeMeeting).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('showDiarizationFailure', () => {
  test('words a failed pass the same way for every caller', () => {
    const error = mock((_message: string, _options?: { description?: string }) => {});

    showDiarizationFailure({ error });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual([
      'Diarization failed',
      { description: DIARIZATION_FAILED_MESSAGE },
    ]);
  });

  test('keeps a native explanation when the event carries one', () => {
    const error = mock((_message: string, _options?: { description?: string }) => {});

    showDiarizationFailure({ error }, DIARIZATION_NO_RUNTIME_MESSAGE);

    expect(error.mock.calls[0]).toEqual([
      'Diarization failed',
      { description: DIARIZATION_NO_RUNTIME_MESSAGE },
    ]);
  });
});

describe('shouldToastDiarizationStatus', () => {
  // Automatic passes (after a recording, import or retranscription) only speak
  // up when something broke: the three configuration statuses were not
  // requested by the user.
  test('toasts only a failed pass', () => {
    const expected: Array<[DiarizationStatus, boolean]> = [
      ['ran', false],
      ['no_model', false],
      ['no_runtime', false],
      ['deferred', false],
      ['failed', true],
    ];

    for (const [status, shouldToast] of expected) {
      expect(shouldToastDiarizationStatus(status)).toBe(shouldToast);
    }
  });
});

describe('shouldToastDiarizationUnavailable', () => {
  // The `diarization-unavailable` native event now fires only for `failed`,
  // but the listener checks the payload status before speaking: if native code
  // ever widens the event, the UI must stay quiet for configuration reasons
  // instead of re-learning the old "toast for everything" behaviour.
  test('stays silent for every status except failed', () => {
    const expected: Array<[DiarizationStatus | undefined, boolean]> = [
      ['ran', false],
      ['no_model', false],
      ['no_runtime', false],
      ['deferred', false],
      ['failed', true],
      [undefined, false],
    ];

    for (const [status, shouldToast] of expected) {
      expect(shouldToastDiarizationUnavailable(status)).toBe(shouldToast);
    }
  });

  test('agrees with the automatic-pass rule', () => {
    for (const status of [
      'ran',
      'no_model',
      'no_runtime',
      'deferred',
      'failed',
    ] as DiarizationStatus[]) {
      expect(shouldToastDiarizationUnavailable(status)).toBe(
        shouldToastDiarizationStatus(status),
      );
    }
  });
});

describe('diarizationStatusMessage', () => {
  test('explains every non-success status and stays silent after a pass', () => {
    const expected: Array<[DiarizationStatus, string | null]> = [
      ['ran', null],
      ['no_model', DIARIZATION_NO_MODEL_MESSAGE],
      ['no_runtime', DIARIZATION_NO_RUNTIME_MESSAGE],
      ['deferred', DIARIZATION_DEFERRED_MESSAGE],
      ['failed', DIARIZATION_FAILED_MESSAGE],
    ];

    for (const [status, message] of expected) {
      expect(diarizationStatusMessage(status)).toBe(message);
    }
  });

  test('a manual run never explains two different refusals with the same text', () => {
    const messages = [
      DIARIZATION_NO_MODEL_MESSAGE,
      DIARIZATION_NO_RUNTIME_MESSAGE,
      DIARIZATION_DEFERRED_MESSAGE,
      DIARIZATION_FAILED_MESSAGE,
    ];

    expect(new Set(messages).size).toBe(messages.length);
  });
});

describe('mirrored native texts', () => {
  // The native constants in
  // `src-tauri/src/audio/transcription/diarization_service.rs` are the source
  // of truth; the frontend duplicates them for direct command answers. The
  // test reads that file and extracts each constant by name, so a third
  // hand-written copy can no longer stand in for the real strings.
  const NATIVE_SOURCE = new URL(
    '../../src-tauri/src/audio/transcription/diarization_service.rs',
    import.meta.url,
  );

  /** Reads a `pub const NAME: &str = "…";` literal out of the native source. */
  function nativeConstant(name: string): string {
    const source = readFileSync(NATIVE_SOURCE, 'utf8');
    const pattern = new RegExp(
      `pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\.)*)"`,
    );
    const match = pattern.exec(source);
    if (!match) {
      throw new Error(`No string constant ${name} in ${NATIVE_SOURCE.pathname}`);
    }
    // Only the escapes the native texts actually use, so a silent mismatch in
    // escaping cannot hide behind `JSON.parse`.
    return match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }

  test('mirror the native message strings verbatim', () => {
    const expected: Array<[string, string]> = [
      [DIARIZATION_NO_MODEL_MESSAGE, nativeConstant('DIARIZATION_UNAVAILABLE_MESSAGE')],
      [
        DIARIZATION_NO_RUNTIME_MESSAGE,
        nativeConstant('DIARIZATION_RUNTIME_UNAVAILABLE_MESSAGE'),
      ],
      [DIARIZATION_FAILED_MESSAGE, nativeConstant('DIARIZATION_FAILED_MESSAGE')],
      [DIARIZATION_DEFERRED_MESSAGE, nativeConstant('DIARIZATION_DEFERRED_MESSAGE')],
      [SPEAKER_NAMES_RESET_HINT, nativeConstant('SPEAKER_NAMES_RESET_MESSAGE')],
    ];

    for (const [actual, expectedText] of expected) {
      expect(actual).toBe(expectedText);
    }
  });

  test('the panel hint is the native no-model sentence, not a new wording', () => {
    // The hint is the part of the native message the panel shows; deriving it
    // here keeps the two from drifting without demanding a second native
    // constant for a substring.
    expect(nativeConstant('DIARIZATION_UNAVAILABLE_MESSAGE')).toContain(
      DIARIZATION_UNAVAILABLE_HINT,
    );
  });

  test('name the native event constants', () => {
    expect(TRANSCRIPT_UPDATED_EVENT).toBe(nativeConstant('TRANSCRIPT_UPDATED_EVENT'));
    expect(SPEAKER_NAMES_RESET_EVENT).toBe(nativeConstant('SPEAKER_NAMES_RESET_EVENT'));
    expect(DIARIZATION_PROGRESS_EVENT).toBe(nativeConstant('DIARIZATION_PROGRESS_EVENT'));
  });

  test('the diarization band start mirrors the native bar scale', () => {
    // The native milestones of both batch paths stop at
    // `audio/progress_scale.rs`'s DIARIZATION_BAND_START, and the frontend
    // band (the bar's start of the pass state's slice, and the synthetic
    // `diarizing` progress both dialogs post on save) must read the same
    // number, or the bar jumps or stalls at the handover.
    const scaleSource = readFileSync(
      new URL('../../src-tauri/src/audio/progress_scale.rs', import.meta.url),
      'utf8',
    );
    const match = /const DIARIZATION_BAND_START: u32 = (\d+);/.exec(scaleSource);
    if (!match) throw new Error('no DIARIZATION_BAND_START in progress_scale.rs');
    expect(DIARIZATION_BAND_START).toBe(Number(match[1]));
  });

  test('the frontend stage union mirrors the native stage enum', () => {
    // The stage names are the payload contract: the panel maps every member
    // to a catalog string, so a native stage the frontend does not know
    // would silently drop its indicator. Read the variants of the native
    // `DiarizationStage` enum and compare the snake_case spelling.
    const source = readFileSync(NATIVE_SOURCE, 'utf8');
    const match = /pub enum DiarizationStage \{([\s\S]*?)\n\}/.exec(source);
    if (!match) throw new Error('no DiarizationStage enum in the native source');
    const nativeStages: string[] = [...match[1].matchAll(/^\s{4}([A-Z][A-Za-z]*),$/gm)].map(
      ([, variant]) =>
        (variant as string).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase(),
    );

    expect([...DIARIZATION_STAGES] as string[]).toEqual(nativeStages);
  });
});

describe('hasInstalledDiarizationModel', () => {
  test('accepts only an installed diarization model', () => {
    // audio.cpp is diarization-only: the catalog exposes no `asr` task any
    // more, so only the diar artifact states below can occur.
    const expected: Array<[Array<{ task: 'diar'; status: unknown }>, boolean]> = [
      [[], false],
      [[{ task: 'diar', status: 'Missing' }], false],
      [[{ task: 'diar', status: { Downloading: { progress: 40 } } }], false],
      [[{ task: 'diar', status: 'Available' }], true],
    ];

    for (const [models, expectedPresence] of expected) {
      expect(
        hasInstalledDiarizationModel(models as Parameters<typeof hasInstalledDiarizationModel>[0]),
      ).toBe(expectedPresence);
    }
  });
});
