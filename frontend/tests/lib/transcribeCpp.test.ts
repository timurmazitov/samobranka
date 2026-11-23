import { describe, expect, test } from 'bun:test';

import {
  TRANSCRIBECPP_COMMANDS,
  TRANSCRIBECPP_EVENTS,
  defaultSelectedTranscriptionModel,
  downloadProgress,
  formatModelSize,
  isAvailableStatus,
  isDownloadingStatus,
  modelDescription,
  quantizationNote,
  type TranscribeCppModelInfo,
  type TranscribeCppModelStatus,
} from '../../src/lib/transcribeCpp';

function model(overrides: Partial<TranscribeCppModelInfo> = {}): TranscribeCppModelInfo {
  return {
    name: 'parakeet-ultra-Q8_0',
    display_name: 'Parakeet Ultra',
    family: 'parakeet-ultra',
    quantization: 'Q8_0',
    filename: 'parakeet-ultra-Q8_0.gguf',
    path: '/models/transcribecpp/parakeet-ultra-Q8_0.gguf',
    size_mb: 706,
    size_bytes: 740_363_168,
    description: 'Multilingual speech recognition (Parakeet Ultra).',
    sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
    status: 'Missing',
    ...overrides,
  };
}

describe('transcribe.cpp model manager types', () => {
  test('names every model management command exactly as lib.rs registers it', () => {
    expect(TRANSCRIBECPP_COMMANDS).toEqual({
      init: 'transcribecpp_model_init',
      getAvailableModels: 'transcribecpp_get_available_models',
      hasAvailableModels: 'transcribecpp_has_available_models',
      hasTranscriptionModel: 'transcribecpp_has_transcription_model',
      getModelsDirectory: 'transcribecpp_get_models_directory',
      downloadModel: 'transcribecpp_download_model',
      cancelDownload: 'transcribecpp_cancel_download',
      deleteModel: 'transcribecpp_delete_model',
      openModelsFolder: 'open_transcribecpp_models_folder',
    });
  });

  test('uses the transcribecpp_ event namespace so listeners cannot collide with audio.cpp', () => {
    expect(TRANSCRIBECPP_EVENTS.progress).toBe('transcribecpp-model-download-progress');
    expect(TRANSCRIBECPP_EVENTS.complete).toBe('transcribecpp-model-download-complete');
    expect(TRANSCRIBECPP_EVENTS.error).toBe('transcribecpp-model-download-error');
  });

  test('exposes an engine-independent model client seam for the UI', () => {
    // The interface is structural: any object with these members works, which
    // is how the settings UI is tested without Tauri. No getDiagnostics: the
    // manager works without the native library, so the UI never asks.
    const fake = {
      init: async () => {},
      getAvailableModels: async () => [],
      hasAvailableModels: async () => false,
      hasTranscriptionModel: async () => false,
      getModelsDirectory: async () => '',
      downloadModel: async () => {},
      cancelDownload: async () => 'cancelled' as const,
      deleteModel: async () => '',
      openModelsFolder: async () => {},
      listenProgress: async () => () => {},
      listenComplete: async () => () => {},
      listenError: async () => () => {},
    };
    expect(typeof fake.init).toBe('function');
  });

  test('recognizes an in-flight download and surfaces its progress', () => {
    const downloading: TranscribeCppModelStatus = { Downloading: { progress: 37 } };

    expect(isDownloadingStatus(downloading)).toBeTrue();
    expect(downloadProgress(downloading)).toBe(37);
    expect(isAvailableStatus(downloading)).toBeFalse();
  });

  test('treats settled states as not downloading', () => {
    for (const status of ['Available', 'Missing', { Error: 'boom' }, { Corrupted: { file_size: 1, expected_min_size: 2 } }] as TranscribeCppModelStatus[]) {
      expect(isDownloadingStatus(status)).toBeFalse();
      expect(downloadProgress(status)).toBeNull();
    }
  });

  test('only an installed artifact counts as available', () => {
    expect(isAvailableStatus('Available')).toBeTrue();
    expect(isAvailableStatus('Missing')).toBeFalse();
    expect(isAvailableStatus({ Corrupted: { file_size: 1, expected_min_size: 2 } })).toBeFalse();
  });

  test('formats catalog sizes the way the other model managers do', () => {
    // Locale-aware spacing from `formatMegabytes` (`units.megabytesShort`
    // renders `{{value}} MB`), same as the other model managers.
    expect(formatModelSize(706)).toBe('706 MB');
    expect(formatModelSize(259)).toBe('259 MB');
    expect(formatModelSize(1591)).toBe('1.6 GB');
  });

  test('resolves the card description by family from the interface catalog', () => {
    // The frontend catalog owns the card prose (native-i18n spec D6); the Rust
    // `description` field is only the fallback for a family without keys yet.
    expect(modelDescription('parakeet-ultra', 'RUST PROSE')).toContain('Parakeet Ultra');
    // A dotted family name is an ordinary catalog key: i18next reassembles
    // segments like `parakeet-tdt-0.6b` around the dots.
    expect(modelDescription('parakeet-tdt-0.6b-v3', 'RUST PROSE')).toContain('NVIDIA Parakeet TDT');
  });

  test('falls back to the Rust catalog description for an unknown family', () => {
    expect(modelDescription('family-without-keys', 'RUST PROSE')).toBe('RUST PROSE');
  });

  test('renders the quantization note the catalog macro used to append', () => {
    expect(quantizationNote('Q8_0')).toBe('Quantization: Q8_0.');
  });

  test('carries family, quantization and sha256 metadata without a task field', () => {
    // The Rust ModelInfo is ASR-only: `task` does not exist and `sha256` does.
    const entry = model();

    expect(entry.family).toBe('parakeet-ultra');
    expect(entry.quantization).toBe('Q8_0');
    expect(entry.sha256).toHaveLength(64);
    expect('task' in entry).toBeFalse();
  });
});

describe('defaultSelectedTranscriptionModel', () => {
  test('prefers the configured installed model', () => {
    const selected = defaultSelectedTranscriptionModel(
      [model({ status: 'Available' }), model({ name: 'gigaam-v3-ctc-Q8_0', status: 'Available' })],
      'gigaam-v3-ctc-Q8_0',
    );
    expect(selected?.name).toBe('gigaam-v3-ctc-Q8_0');
  });

  test('falls back to the installed model when the configured one is missing', () => {
    const selected = defaultSelectedTranscriptionModel(
      [model({ status: 'Missing' }), model({ name: 'gigaam-v3-ctc-Q8_0', status: 'Available' })],
      'parakeet-ultra-Q8_0',
    );
    expect(selected?.name).toBe('gigaam-v3-ctc-Q8_0');
  });

  test('reports no selection when nothing is installed yet', () => {
    expect(defaultSelectedTranscriptionModel([], undefined)).toBeUndefined();
    expect(defaultSelectedTranscriptionModel([model({ status: 'Missing' })], undefined))
      .toBeUndefined();
  });
});
