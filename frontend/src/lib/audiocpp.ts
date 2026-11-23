import i18n, { type AppLanguageCode } from '@/i18n';
import { formatMegabytes } from '@/lib/format-locale';

/**
 * Types and Tauri command wrappers for the audio.cpp (Nemotron) model manager.
 *
 * audio.cpp now serves one purpose: speaker diarization over a finished
 * transcript. The transcription (asr) path was removed with the transcribe.cpp
 * consolidation, so the catalog and this client expose only diarization.
 */

/** Task a catalogued model performs, in audio.cpp terms. */
export type AudioCppModelTask = 'diar';

/** Quantization of the published weights. */
export type AudioCppQuantization = 'BF16';

export type AudioCppModelStatus =
  | 'Available'
  | 'Missing'
  | { Downloading: { progress: number } }
  | { Error: string }
  | { Corrupted: { file_size: number; expected_min_size: number } };

export interface AudioCppModelInfo {
  name: string;
  display_name: string;
  family: string;
  task: AudioCppModelTask;
  quantization: AudioCppQuantization;
  filename: string;
  path: string;
  size_mb: number;
  size_bytes: number;
  description: string;
  status: AudioCppModelStatus;
}

export type AudioCppCancelDownloadOutcome = 'cancelled' | 'pending';

export type AudioCppDownloadEventStatus = 'downloading' | 'completed' | 'cancelled';

export interface AudioCppDownloadProgressEvent {
  modelName: string;
  progress: number;
  /** Downloaded size in MiB, from the catalogued model size. */
  downloaded_mb?: number;
  /** Catalogued model size in MiB. */
  total_mb?: number;
  /** Measured rate since the previous report, in MiB/s. */
  speed_mbps?: number;
  status: AudioCppDownloadEventStatus;
}

export interface AudioCppDownloadCompleteEvent {
  modelName: string;
}

export interface AudioCppDownloadErrorEvent {
  modelName: string;
  error: string;
}

/**
 * Diagnostic report on the native audio.cpp library: whether it loaded, its
 * ABI/build version, and the model families and tasks it supports. A missing
 * or ABI-incompatible library is reported in-band (`available: false` with an
 * explanatory `error`), never as a command failure.
 */
export interface AudioCppDiagnostics {
  available: boolean;
  library_path: string | null;
  abi_version: string | null;
  build_version: string | null;
  families: string[];
  tasks: string[];
  error: string | null;
}

/**
 * Tauri command names of the native audio.cpp model manager. The Rust side
 * registers exactly these in `lib.rs`; keeping them in one place makes the
 * contract testable without importing the Tauri bridge.
 */
export const AUDIOCPP_COMMANDS = {
  init: 'audiocpp_model_init',
  getAvailableModels: 'audiocpp_get_available_models',
  hasAvailableModels: 'audiocpp_has_available_models',
  getModelsDirectory: 'audiocpp_get_models_directory',
  downloadModel: 'audiocpp_download_model',
  cancelDownload: 'audiocpp_cancel_download',
  deleteModel: 'audiocpp_delete_model',
  openModelsFolder: 'open_audiocpp_models_folder',
  diagnostics: 'audiocpp_diagnostics',
} as const;

/** Event names emitted by the native audio.cpp model manager. */
export const AUDIOCPP_EVENTS = {
  progress: 'audiocpp-model-download-progress',
  complete: 'audiocpp-model-download-complete',
  error: 'audiocpp-model-download-error',
} as const;

/** Task label shown in the model manager. */
export function taskLabel(_task: AudioCppModelTask): string {
  return i18n.t('models.audioCpp.taskDiarization');
}

/**
 * Card description, resolved by family from the interface catalog
 * (`models.audioCpp.descriptions.<family>`, native-i18n spec D6), the same
 * precedent as `taskLabel()`. `fallback` is the Rust catalog's English prose,
 * shown for a family whose keys have not landed yet.
 */
export function modelDescription(family: string, fallback: string): string {
  const key = `models.audioCpp.descriptions.${family}`;
  const resolved = i18n.t(key, { defaultValue: fallback });
  return resolved === key ? fallback : resolved;
}

/** Whether a status value represents an in-flight download. */
export function isDownloadingStatus(status: AudioCppModelStatus): boolean {
  return typeof status === 'object' && status !== null && 'Downloading' in status;
}

/** Progress percentage of an in-flight download, otherwise `null`. */
export function downloadProgress(status: AudioCppModelStatus): number | null {
  return isDownloadingStatus(status)
    ? (status as { Downloading: { progress: number } }).Downloading.progress
    : null;
}

/** Whether a status value means the artifact is installed and usable. */
export function isAvailableStatus(status: AudioCppModelStatus): boolean {
  return status === 'Available';
}

/** Human-readable size, matching the other model managers. */
export function formatModelSize(sizeMb: number): string {
  return formatMegabytes(sizeMb, i18n.language as AppLanguageCode);
}

/** Unlisten handle returned by an event subscription. */
export type UnlistenFn = () => void;

/**
 * The seam between the model manager UI and the native audio.cpp model
 * manager: commands plus the three download events. Production code uses
 * `audioCppClient` from `./audiocppClient`; tests inject a fake so component
 * behaviour can be exercised without Tauri or process-wide module mocks.
 *
 * This module is deliberately free of Tauri imports so it can be imported by
 * plain unit tests.
 */
export interface AudioCppModelClient {
  init(): Promise<void>;
  getAvailableModels(): Promise<AudioCppModelInfo[]>;
  hasAvailableModels(): Promise<boolean>;
  getModelsDirectory(): Promise<string>;
  /** Runtime report: whether the native library loaded, and why not. */
  getDiagnostics(): Promise<AudioCppDiagnostics>;
  downloadModel(modelName: string): Promise<void>;
  cancelDownload(modelName: string): Promise<AudioCppCancelDownloadOutcome>;
  deleteModel(modelName: string): Promise<string>;
  openModelsFolder(): Promise<void>;
  listenProgress(handler: (event: AudioCppDownloadProgressEvent) => void): Promise<UnlistenFn>;
  listenComplete(handler: (event: AudioCppDownloadCompleteEvent) => void): Promise<UnlistenFn>;
  listenError(handler: (event: AudioCppDownloadErrorEvent) => void): Promise<UnlistenFn>;
}
