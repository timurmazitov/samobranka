/**
 * Whether a diarization pass can run on this machine at all.
 *
 * The rules mirror what the backend's pass decision checks (an installed
 * Nemotron diarization model, an audio.cpp runtime that can load, and no
 * active recording): the import and retranscription dialogs end their bar at
 * transcription without waiting for a terminal that will never come when any
 * of them is missing, and they must reach that verdict the same way the
 * speakers panel learns about the model — through the catalog, never by
 * guessing.
 *
 * An unreadable catalog or failed diagnostics probe is deliberately not
 * "unavailable": absence of knowledge is not knowledge of absence, so the
 * caller keeps waiting for the pass instead of ending the bar early.
 */

import {
  hasInstalledDiarizationModel,
  diarizationBarValue,
  type DiarizationPassState,
} from './diarization';
import type {
  AudioCppDiagnostics,
  AudioCppModelInfo,
} from './audiocpp';
import { AUDIOCPP_COMMANDS } from './audiocpp';

/** What the caller knows after reading the catalog and the runtime probe. */
export type DiarizationAvailability = 'available' | 'unavailable' | 'unknown';

/** The part of the audio.cpp client the rule needs; injectable for tests. */
export interface DiarizationAvailabilityClient {
  getAvailableModels(): Promise<AudioCppModelInfo[]>;
  getDiagnostics(): Promise<AudioCppDiagnostics>;
  /** Whether a recording is active; a pass would defer for it. */
  isRecording(): Promise<boolean>;
}

/**
 * Folds the three reads into the verdict, mirroring the native pass decision
 * (`no_model` → `no_runtime` → `deferred`). Any input still missing (the
 * catalog threw, a probe was never made) is `unknown`, never `unavailable`.
 */
export function foldDiarizationAvailability(
  models: AudioCppModelInfo[] | null,
  runtimeAvailable: boolean | null,
  recordingActive: boolean | null,
): DiarizationAvailability {
  if (models === null || runtimeAvailable === null || recordingActive === null) return 'unknown';
  if (!hasInstalledDiarizationModel(models)) return 'unavailable';
  if (!runtimeAvailable) return 'unavailable';
  // A deferred pass is silent by contract, so a dialog that waited for its
  // terminal would hang; the caller treats it exactly like "no pass".
  if (recordingActive) return 'unavailable';
  return 'available';
}

/**
 * Reads the catalog and probes the runtime, tolerating either read failing:
 * a failed read leaves its side unknown, which keeps the caller waiting for
 * the real pass instead of ending the bar on a guess.
 */
export async function checkDiarizationAvailability(
  client: DiarizationAvailabilityClient,
): Promise<DiarizationAvailability> {
  const [modelsResult, diagnosticsResult, recordingResult] = await Promise.allSettled([
    client.getAvailableModels(),
    client.getDiagnostics(),
    client.isRecording(),
  ]);
  // A fulfilled-but-malformed read (a fake bridge, an old payload) reads the
  // same as a failed one: unknown, never a verdict.
  const models =
    modelsResult.status === 'fulfilled' && Array.isArray(modelsResult.value)
      ? modelsResult.value
      : null;
  const diagnostics =
    diagnosticsResult.status === 'fulfilled' ? diagnosticsResult.value : null;
  const runtimeAvailable =
    diagnostics && typeof diagnostics.available === 'boolean' ? diagnostics.available : null;
  const recordingActive =
    recordingResult.status === 'fulfilled' && typeof recordingResult.value === 'boolean'
      ? recordingResult.value
      : null;
  return foldDiarizationAvailability(models, runtimeAvailable, recordingActive);
}

/**
 * Production client: the audio.cpp catalog and runtime probe from the model
 * client's command registry, plus the recording flag the native pass decision
 * also checks. Tauri's `invoke` is imported lazily (the diarization seam
 * pattern) so unit tests that inject a fake never touch the native bridge.
 */
export const defaultDiarizationAvailabilityClient: DiarizationAvailabilityClient = {
  getAvailableModels: async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AudioCppModelInfo[]>(AUDIOCPP_COMMANDS.getAvailableModels);
  },
  getDiagnostics: async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AudioCppDiagnostics>(AUDIOCPP_COMMANDS.diagnostics);
  },
  isRecording: async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('is_recording');
  },
};

/**
 * Where a pass percentage belongs on the import bar. The native milestones
 * bring the bar to `DIARIZATION_BAND_START` (the same constant `import.rs`
 * stops at); from there the shared pass state projects through the band —
 * each stage owns a slice of 75..99 in emission order and its honest
 * percentage interpolates only inside its own slice, so the bar keeps moving
 * forward and never reads 100 before its terminal (the dialog switches to
 * 100 only when the pass state is gone). Without any pass the bar keeps the
 * transcription value.
 */
export function importBarPercentage(
  progressPercentage: number | null | undefined,
  pass: DiarizationPassState | null,
): number {
  if (pass) return diarizationBarValue(pass);
  return progressPercentage === undefined || progressPercentage === null
    ? 0
    : Math.min(progressPercentage, 100);
}

/**
 * The retranscription bar uses the import bar's scale unchanged (see
 * `retranscription.rs`), so it reads the same band mapping; the alias names
 * the mapping for its second caller without duplicating the rule.
 */
export const retranscriptionBarPercentage = importBarPercentage;
