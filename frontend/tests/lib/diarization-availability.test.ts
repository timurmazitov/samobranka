/**
 * The availability rule the import (and later retranscription) dialogs use to
 * decide whether a diarization terminal is owed at all.
 *
 * The dialogs may only end the bar at transcription when the frontend knows
 * the pass will not run — the same knowledge the speakers panel has (the
 * catalog for the model, the runtime probe, the recording flag). An
 * unreadable catalog or failed probe must never read as "no model": absence
 * of knowledge is not knowledge of absence, and a wrong "unavailable" would
 * end the bar while a pass is actually running.
 */

import { describe, expect, test } from 'bun:test';

import {
  checkDiarizationAvailability,
  foldDiarizationAvailability,
  importBarPercentage,
  type DiarizationAvailabilityClient,
} from '../../src/lib/diarizationAvailability';
import type { AudioCppDiagnostics, AudioCppModelInfo } from '../../src/lib/audiocpp';
import type { DiarizationPassState } from '../../src/lib/diarization';

function model(overrides: Partial<AudioCppModelInfo> = {}): AudioCppModelInfo {
  return {
    name: 'nemotron-3-diarization-bf16',
    display_name: 'Nemotron 3 Diarization (BF16)',
    family: 'nemotron',
    task: 'diar',
    quantization: 'BF16',
    filename: 'model.nemo',
    path: '/models/model.nemo',
    size_mb: 100,
    size_bytes: 100 * 1024 * 1024,
    description: '',
    status: 'Available',
    ...overrides,
  };
}

function diagnostics(available: boolean): AudioCppDiagnostics {
  return {
    available,
    library_path: available ? '/lib/libaudiocpp.so' : null,
    abi_version: available ? '1' : null,
    build_version: available ? '1' : null,
    families: available ? ['nemotron'] : [],
    tasks: available ? ['diar'] : [],
    error: available ? null : 'library missing',
  };
}

function client(
  models: AudioCppModelInfo[],
  runtimeAvailable: boolean,
  recording = false,
): DiarizationAvailabilityClient {
  return {
    getAvailableModels: async () => models,
    getDiagnostics: async () => diagnostics(runtimeAvailable),
    isRecording: async () => recording,
  };
}

describe('foldDiarizationAvailability', () => {
  test('an installed diar model, a loadable runtime, and no recording mean available', () => {
    expect(foldDiarizationAvailability([model()], true, false)).toBe('available');
  });

  test('the model outranks the runtime, the runtime outranks the recording', () => {
    // Mirrors the native decision priority: no_model → no_runtime → deferred.
    expect(foldDiarizationAvailability([], false, true)).toBe('unavailable');
    expect(foldDiarizationAvailability([model()], false, true)).toBe('unavailable');
    expect(foldDiarizationAvailability([model()], true, true)).toBe('unavailable');
  });

  test('a catalogued model that is not an installed diar model is unavailable', () => {
    expect(foldDiarizationAvailability([model({ status: 'Missing' })], true, false)).toBe(
      'unavailable',
    );
    expect(foldDiarizationAvailability([], true, false)).toBe('unavailable');
  });

  test('a missing read keeps the verdict unknown, never unavailable', () => {
    // The callers keep waiting for the pass on `unknown`; only a positive
    // "there is no model / no runtime / a recording runs" ends the bar early.
    expect(foldDiarizationAvailability(null, true, false)).toBe('unknown');
    expect(foldDiarizationAvailability([model()], null, false)).toBe('unknown');
    expect(foldDiarizationAvailability([model()], true, null)).toBe('unknown');
    expect(foldDiarizationAvailability(null, null, null)).toBe('unknown');
  });
});

describe('checkDiarizationAvailability', () => {
  test('a healthy machine answers available', async () => {
    await expect(checkDiarizationAvailability(client([model()], true))).resolves.toBe('available');
  });

  test('a failed catalog read stays unknown', async () => {
    const broken = client([], true);
    broken.getAvailableModels = async () => {
      throw new Error('catalog unreadable');
    };
    await expect(checkDiarizationAvailability(broken)).resolves.toBe('unknown');
  });

  test('a failed runtime probe stays unknown', async () => {
    const broken = client([model()], false);
    broken.getDiagnostics = async () => {
      throw new Error('probe failed');
    };
    await expect(checkDiarizationAvailability(broken)).resolves.toBe('unknown');
  });

  test('a malformed read reads as unknown, not as a verdict', async () => {
    // A fake bridge or an old payload shape must not silently mean "no model".
    const malformed = client([model()], true);
    malformed.getAvailableModels = (async () => undefined) as never;
    await expect(checkDiarizationAvailability(malformed)).resolves.toBe('unknown');
  });

  test('a running recording defers the pass and reads unavailable', async () => {
    await expect(checkDiarizationAvailability(client([model()], true, true))).resolves.toBe(
      'unavailable',
    );
  });
});

describe('importBarPercentage', () => {
  function pass(overrides: Partial<DiarizationPassState> = {}): DiarizationPassState {
    return {
      meetingId: 'meeting-a',
      stage: 'inferring',
      progressPercentage: null,
      message: null,
      phase: 'running',
      error: null,
      ...overrides,
    };
  }

  test('without a pass the bar keeps the native milestone', () => {
    expect(importBarPercentage(40, null)).toBe(40);
    expect(importBarPercentage(100, null)).toBe(100);
    expect(importBarPercentage(undefined, null)).toBe(0);
  });

  test('each stage sits at the start of its own band slice', () => {
    // The five stages split 75..99 in emission order (decoding runs before
    // the model load — the physical pass order), so a later stage always
    // reads further along the bar than any point an earlier stage can reach.
    expect(importBarPercentage(75, pass({ stage: 'queued' }))).toBe(75);
    expect(importBarPercentage(75, pass({ stage: 'decoding' }))).toBe(80);
    expect(importBarPercentage(75, pass({ stage: 'loading_model' }))).toBe(85);
    expect(importBarPercentage(75, pass({ stage: 'inferring' }))).toBe(90);
    expect(importBarPercentage(75, pass({ stage: 'applying_labels' }))).toBe(95);
  });

  test('a stage percentage interpolates inside its own slice, never into the next stage', () => {
    expect(importBarPercentage(75, pass({ stage: 'loading_model', progressPercentage: 0 }))).toBe(85);
    expect(importBarPercentage(75, pass({ stage: 'loading_model', progressPercentage: 50 }))).toBe(87);
    // The committed checkpoint tops the stage's slice at 89 — it does not
    // reach 100, and the indeterminate stage that follows (90) only moves
    // the bar forward: the sawtooth the old 75 + pct/4 mapping produced is
    // gone.
    expect(importBarPercentage(75, pass({ stage: 'loading_model', progressPercentage: 100 }))).toBe(89);
    expect(importBarPercentage(75, pass({ stage: 'inferring' }))).toBe(90);
  });

  test('the bar never reaches 100 before the terminal', () => {
    // 99 is the top a running pass shows, even at the last stage's final
    // checkpoint; only the dialog's own complete state (no pass state) reads
    // 100. A wild percentage cannot lift it either (the reducer clamps it to
    // indeterminate, and the cap holds regardless).
    expect(importBarPercentage(75, pass({ stage: 'applying_labels', progressPercentage: 100 }))).toBe(99);
    expect(importBarPercentage(75, pass({ stage: 'applying_labels', progressPercentage: 999 }))).toBeLessThan(100);
  });

  test('the whole honest pass sequence is monotonic', () => {
    const sequence: Array<Partial<DiarizationPassState>> = [
      { stage: 'queued' },
      { stage: 'decoding' },
      { stage: 'loading_model', progressPercentage: 0 },
      { stage: 'loading_model', progressPercentage: 100 },
      { stage: 'inferring' },
      { stage: 'applying_labels', progressPercentage: 0 },
      { stage: 'applying_labels', progressPercentage: 100 },
    ];
    let previous = 0;
    for (const overrides of sequence) {
      const value = importBarPercentage(75, pass(overrides));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
    expect(previous).toBe(99);
  });
});
