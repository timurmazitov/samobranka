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
import en from '../../src/i18n/locales/en/translation.json';
import ru from '../../src/i18n/locales/ru/translation.json';
import {
  AUDIOCPP_DIARIZE_COMMAND,
  DIARIZATION_PROGRESS_EVENT,
  DIARIZATION_STAGES,
  DIARIZATION_BAND_START,
  SPEAKER_NAMES_RESET_EVENT,
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

  test('only a failed pass interrupts the user, and explains it with the localized failure text', async () => {
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
          description: en.speakers.failures.failed,
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
      { description: en.speakers.failures.failed },
    ]);
  });

  test('renders the catalog sentence for a known native code, whatever the prose says', () => {
    const error = mock((_message: string, _options?: { description?: string }) => {});

    showDiarizationFailure({ error }, { code: 'runtime_unavailable', message: 'stale prose' });

    expect(error.mock.calls[0]).toEqual([
      'Diarization failed',
      { description: en.speakers.failures.runtime_unavailable },
    ]);
  });

  test('falls back to the native prose for a code the catalog does not know', () => {
    // D7: an additive payload may carry a code newer than this build; the
    // prose field is what keeps the toast from going empty.
    const error = mock((_message: string, _options?: { description?: string }) => {});

    showDiarizationFailure({ error }, { code: 'from_the_future', message: 'Native explains itself' });

    expect(error.mock.calls[0]).toEqual([
      'Diarization failed',
      { description: 'Native explains itself' },
    ]);
  });

  test('falls back to the generic failure sentence when neither code nor prose speaks', () => {
    const error = mock((_message: string, _options?: { description?: string }) => {});

    showDiarizationFailure({ error }, { code: 'from_the_future', message: '   ' });

    expect(error.mock.calls[0]).toEqual([
      'Diarization failed',
      { description: en.speakers.failures.failed },
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
    // The single source of truth is the frontend catalog: the panel answers an
    // explicit run with `speakers.failures.<status>` in the current language.
    const expected: Array<[DiarizationStatus, string | null]> = [
      ['ran', null],
      ['no_model', en.speakers.failures.unavailable],
      ['no_runtime', en.speakers.failures.runtime_unavailable],
      ['deferred', en.speakers.failures.deferred],
      ['failed', en.speakers.failures.failed],
    ];

    for (const [status, message] of expected) {
      expect(diarizationStatusMessage(status)).toBe(message);
    }
  });

  test('a manual run never explains two different refusals with the same text', () => {
    const messages = [
      en.speakers.failures.unavailable,
      en.speakers.failures.runtime_unavailable,
      en.speakers.failures.deferred,
      en.speakers.failures.failed,
    ];

    expect(new Set(messages).size).toBe(messages.length);
  });
});

/**
 * The state codes the native terminal payloads carry, mirroring the
 * `DiarizationStateCode` constants in `diarization_service.rs` (the frontend
 * catalog keys `speakers.failures.<code>` hang off them).
 */
const STATE_CODES = [
  'unavailable',
  'runtime_unavailable',
  'failed',
  'deferred',
  'reset',
] as const;

/** Reads a leaf out of an imported catalog JSON by dotted path. */
function catalogValue(catalog: unknown, key: string): unknown {
  let value: unknown = catalog;
  for (const part of key.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

describe('failure state codes', () => {
  // D8: the frontend catalog is the single source of truth for the diarization
  // sentences. Rust emits a stable state code with the terminal payloads and
  // the UI resolves it through `t('speakers.failures.<code>')` — so what the
  // old "the two texts match" pin asserted is now asserted as: every code the
  // native side can send resolves to a real, non-empty translation in both
  // locales, and the code literals themselves are pinned to the native source
  // (same readFileSync technique as the event-name pin below, so a code added
  // on one side only fails loudly here).
  const NATIVE_SOURCE = new URL(
    '../../src-tauri/src/audio/transcription/diarization_service.rs',
    import.meta.url,
  );

  test('every state code resolves to a non-empty translation in both locales', () => {
    for (const code of STATE_CODES) {
      for (const [language, catalog] of [
        ['en', en],
        ['ru', ru],
      ] as const) {
        const value = catalogValue(catalog, `speakers.failures.${code}`);
        expect({ language, code, value }).toMatchObject({
          value: expect.stringMatching(/\S/),
        });
      }
    }
  });

  test('the native payload code constants match the frontend catalog codes', () => {
    // The payload keys and the code literals are the contract: a native emit
    // outside this set would render the generic fallback instead of an
    // explanation, so it must not appear silently.
    const source = readFileSync(NATIVE_SOURCE, 'utf8');
    const constants = [...source.matchAll(/pub const [A-Z_]+: &str = "([a-z_]+)";/g)]
      .map(([, value]) => value)
      .filter((value) => (STATE_CODES as readonly string[]).includes(value));

    // All five are present as native constants…
    expect([...new Set(constants)].sort()).toEqual([...STATE_CODES].sort());

    // …and the two emits use exactly the mapping the catalog keys assume:
    // `unavailable_code(status)` for `diarization-unavailable`, the reset
    // constant for `speaker-names-reset`.
    const runSource = readFileSync(
      new URL('../../src-tauri/src/audio/transcription/diarization_run.rs', import.meta.url),
      'utf8',
    );
    expect(runSource).toMatch(/"code": unavailable_code\(\*status\)/);
    expect(runSource).toMatch(/SPEAKER_NAMES_RESET_EVENT,[\s\S]{0,220}"code": SPEAKER_NAMES_RESET_CODE/);
    // The five mirrored sentences are gone from the native source entirely:
    // the catalog is the only producer (grep acceptance criterion, pinned).
    expect(source).not.toMatch(/Speaker labels were/);
    expect(source).not.toMatch(/Speaker names were reset because/);
  });
});

describe('native event and stage contracts', () => {
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

  test('every stage has a catalog sentence in both locales', () => {
    // `diarizationStageMessage()` switches over the union and never falls back
    // to the native `message` field, so an absent key would render the raw
    // key path on screen. The Rust stage sentences (`DiarizationPhase::message`)
    // are log-only self-description, never a render fallback.
    for (const stage of DIARIZATION_STAGES) {
      for (const [language, catalog] of [
        ['en', en],
        ['ru', ru],
      ] as const) {
        const value = catalogValue(catalog, `speakers.stages.${stage}`);
        expect({ language, stage, value }).toMatchObject({
          value: expect.stringMatching(/\S/),
        });
      }
    }
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
