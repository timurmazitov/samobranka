import i18n, { type AppLanguageCode } from '@/i18n';
import { formatMegabytes } from '@/lib/format-locale';

/**
 * Types and Tauri command names for the transcribe.cpp model manager.
 *
 * The catalog is ASR-only (unlike audio.cpp there is no diarization task),
 * so a model is described by its family and quantization alone and every
 * installed model can transcribe. The shape below mirrors the Rust serde
 * payload in `transcribe_cpp_engine/catalog.rs` (snake_case fields, tagged
 * status enum).
 */

/** Quantization of the published weights, as the catalog offers them. */
export type TranscribeCppQuantization = 'F16' | 'Q8_0' | 'Q6_K' | 'Q5_K_M' | 'Q4_K_M';

export type TranscribeCppModelStatus =
  | 'Available'
  | 'Missing'
  | { Downloading: { progress: number } }
  | { Error: string }
  | { Corrupted: { file_size: number; expected_min_size: number } };

export interface TranscribeCppModelInfo {
  name: string;
  display_name: string;
  family: string;
  quantization: TranscribeCppQuantization;
  filename: string;
  path: string;
  size_mb: number;
  size_bytes: number;
  description: string;
  /** SHA-256 digest of the artifact as published upstream, lowercase hex. */
  sha256: string;
  status: TranscribeCppModelStatus;
}

export type TranscribeCppCancelDownloadOutcome = 'cancelled' | 'pending';

export type TranscribeCppDownloadEventStatus = 'downloading' | 'completed' | 'cancelled';

export interface TranscribeCppDownloadProgressEvent {
  modelName: string;
  progress: number;
  /** Downloaded size in MiB, from the catalogued model size. */
  downloaded_mb?: number;
  /** Catalogued model size in MiB. */
  total_mb?: number;
  /** Measured rate since the previous report, in MiB/s. */
  speed_mbps?: number;
  status: TranscribeCppDownloadEventStatus;
}

export interface TranscribeCppDownloadCompleteEvent {
  modelName: string;
}

export interface TranscribeCppDownloadErrorEvent {
  modelName: string;
  error: string;
}

/**
 * Tauri command names of the transcribe.cpp model manager. The Rust side
 * registers exactly these in `lib.rs`; keeping them in one place makes the
 * contract testable without importing the Tauri bridge. There is no
 * diagnostics command here on purpose: the manager works without the native
 * library, so the UI never needs a runtime report.
 */
export const TRANSCRIBECPP_COMMANDS = {
  init: 'transcribecpp_model_init',
  getAvailableModels: 'transcribecpp_get_available_models',
  hasAvailableModels: 'transcribecpp_has_available_models',
  hasTranscriptionModel: 'transcribecpp_has_transcription_model',
  getModelsDirectory: 'transcribecpp_get_models_directory',
  downloadModel: 'transcribecpp_download_model',
  cancelDownload: 'transcribecpp_cancel_download',
  deleteModel: 'transcribecpp_delete_model',
  openModelsFolder: 'open_transcribecpp_models_folder',
} as const;

/** Event names emitted by the transcribe.cpp model manager. */
export const TRANSCRIBECPP_EVENTS = {
  progress: 'transcribecpp-model-download-progress',
  complete: 'transcribecpp-model-download-complete',
  error: 'transcribecpp-model-download-error',
} as const;

/** Whether a status value represents an in-flight download. */
export function isDownloadingStatus(status: TranscribeCppModelStatus): boolean {
  return typeof status === 'object' && status !== null && 'Downloading' in status;
}

/** Progress percentage of an in-flight download, otherwise `null`. */
export function downloadProgress(status: TranscribeCppModelStatus): number | null {
  return isDownloadingStatus(status)
    ? (status as { Downloading: { progress: number } }).Downloading.progress
    : null;
}

/** Whether a status value means the artifact is installed and usable. */
export function isAvailableStatus(status: TranscribeCppModelStatus): boolean {
  return status === 'Available';
}

/** Human-readable size, matching the other model managers. */
export function formatModelSize(sizeMb: number): string {
  return formatMegabytes(sizeMb, i18n.language as AppLanguageCode);
}

/**
 * Card description, resolved by family from the interface catalog
 * (`models.transcribeCpp.descriptions.<family>`, native-i18n spec D6), the
 * same way `taskLabel()` resolves the audio.cpp task badge. Family names can
 * contain dots (`parakeet-tdt-0.6b-v3`): i18next's deep lookup reassembles
 * segments that are not themselves keys, so the dotted family resolves to one
 * catalog entry. `fallback` is the Rust catalog's English prose, shown for a
 * family whose keys have not landed yet.
 */
export function modelDescription(family: string, fallback: string): string {
  const key = `models.transcribeCpp.descriptions.${family}`;
  const resolved = i18n.t(key, { defaultValue: fallback });
  return resolved === key ? fallback : resolved;
}

/**
 * Quantization note shown next to the quantization badge. The catalog macro
 * used to bake this sentence into `description` at compile time; the card
 * renders it from the interface catalog instead (native-i18n ticket 04).
 */
export function quantizationNote(quantization: string): string {
  return i18n.t('models.transcribeCpp.quantizationNote', { quantization });
}

/** Unlisten handle returned by an event subscription. */
export type UnlistenFn = () => void;

/**
 * The model the settings should offer for selection: the configured one when
 * it is installed, otherwise the first installed model. The catalog is
 * ASR-only, so — unlike audio.cpp — no task filter is needed. Mirrors the
 * native selection rules.
 */
export function defaultSelectedTranscriptionModel(
  models: TranscribeCppModelInfo[],
  configured?: string,
): TranscribeCppModelInfo | undefined {
  return models.find(model => model.name === configured && isAvailableStatus(model.status))
    ?? models.find(model => isAvailableStatus(model.status));
}

/**
 * The seam between the model manager UI and the native transcribe.cpp model
 * manager: commands plus the three download events. Production code uses
 * `transcribeCppClient` from `./transcribeCppClient`; tests inject a fake so
 * component behaviour can be exercised without Tauri or process-wide module
 * mocks.
 *
 * This module is deliberately free of Tauri imports so it can be imported by
 * plain unit tests.
 */
export interface TranscribeCppModelClient {
  init(): Promise<void>;
  getAvailableModels(): Promise<TranscribeCppModelInfo[]>;
  hasAvailableModels(): Promise<boolean>;
  /** Whether an installed model can transcribe; the catalog is ASR-only. */
  hasTranscriptionModel(): Promise<boolean>;
  getModelsDirectory(): Promise<string>;
  downloadModel(modelName: string): Promise<void>;
  cancelDownload(modelName: string): Promise<TranscribeCppCancelDownloadOutcome>;
  deleteModel(modelName: string): Promise<string>;
  openModelsFolder(): Promise<void>;
  listenProgress(handler: (event: TranscribeCppDownloadProgressEvent) => void): Promise<UnlistenFn>;
  listenComplete(handler: (event: TranscribeCppDownloadCompleteEvent) => void): Promise<UnlistenFn>;
  listenError(handler: (event: TranscribeCppDownloadErrorEvent) => void): Promise<UnlistenFn>;
}
