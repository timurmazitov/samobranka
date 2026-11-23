import { describe, expect, test } from 'bun:test';

import {
  AUDIOCPP_COMMANDS,
  AUDIOCPP_EVENTS,
  downloadProgress,
  formatModelSize,
  isAvailableStatus,
  isDownloadingStatus,
  modelDescription,
  taskLabel,
  type AudioCppModelInfo,
  type AudioCppModelStatus,
} from '../../src/lib/audiocpp';

function diarModel(overrides: Partial<AudioCppModelInfo> = {}): AudioCppModelInfo {
  return {
    name: 'nemotron-3-diarization-bf16',
    display_name: 'Nemotron-3 Diarization',
    family: 'nemotron_3_diar',
    task: 'diar',
    quantization: 'BF16',
    filename: 'nemotron-3-diarization-bf16.gguf',
    path: '/models/audiocpp/nemotron-3-diarization-bf16.gguf',
    size_mb: 190,
    size_bytes: 198_720_928,
    description: 'Speaker diarization',
    status: 'Missing',
    ...overrides,
  };
}

describe('audio.cpp model manager types', () => {
  test('names every model management command exactly as lib.rs registers it', () => {
    expect(AUDIOCPP_COMMANDS).toEqual({
      init: 'audiocpp_model_init',
      getAvailableModels: 'audiocpp_get_available_models',
      hasAvailableModels: 'audiocpp_has_available_models',
      getModelsDirectory: 'audiocpp_get_models_directory',
      downloadModel: 'audiocpp_download_model',
      cancelDownload: 'audiocpp_cancel_download',
      deleteModel: 'audiocpp_delete_model',
      openModelsFolder: 'open_audiocpp_models_folder',
      diagnostics: 'audiocpp_diagnostics',
    });
  });

  test('exposes an engine-independent model client seam for the UI', () => {
    // The interface is structural: any object with these members works, which
    // is how the settings UI is tested without Tauri.
    const fake = {
      init: async () => {},
      getAvailableModels: async () => [],
      hasAvailableModels: async () => false,
      getModelsDirectory: async () => '',
      getDiagnostics: async () => ({
        available: false,
        library_path: null,
        abi_version: null,
        build_version: null,
        families: [],
        tasks: [],
        error: 'libaudiocpp not found',
      }),
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

  test('uses the audiocpp_ event namespace so listeners cannot collide with the other engines', () => {
    expect(AUDIOCPP_EVENTS.progress).toBe('audiocpp-model-download-progress');
    expect(AUDIOCPP_EVENTS.complete).toBe('audiocpp-model-download-complete');
    expect(AUDIOCPP_EVENTS.error).toBe('audiocpp-model-download-error');
  });

  test('labels the diarization task for the UI', () => {
    // audio.cpp is diarization-only: the transcription task label is gone.
    expect(taskLabel('diar')).toBe('Diarization');
  });

  test('recognizes an in-flight download and surfaces its progress', () => {
    const downloading: AudioCppModelStatus = { Downloading: { progress: 37 } };

    expect(isDownloadingStatus(downloading)).toBeTrue();
    expect(downloadProgress(downloading)).toBe(37);
    expect(isAvailableStatus(downloading)).toBeFalse();
  });

  test('treats settled states as not downloading', () => {
    for (const status of ['Available', 'Missing', { Error: 'boom' }, { Corrupted: { file_size: 1, expected_min_size: 2 } }] as AudioCppModelStatus[]) {
      expect(isDownloadingStatus(status)).toBeFalse();
      expect(downloadProgress(status)).toBeNull();
    }
  });

  test('only an installed artifact counts as available', () => {
    expect(isAvailableStatus('Available')).toBeTrue();
    expect(isAvailableStatus('Missing')).toBeFalse();
    expect(isAvailableStatus({ Corrupted: { file_size: 1, expected_min_size: 2 } })).toBeFalse();
  });

  test('resolves the diarization card description by family', () => {
    // Same D6 shape as transcribe.cpp: the card ignores the Rust-authored
    // prose and resolves the family key from the interface catalog.
    expect(modelDescription('nemotron_3_diar', 'RUST PROSE')).toContain('Nemotron-3');
  });

  test('falls back to the Rust catalog description for an unknown family', () => {
    expect(modelDescription('family-without-keys', 'RUST PROSE')).toBe('RUST PROSE');
  });

  test('formats catalog sizes the way the other model managers do', () => {
    // Locale-aware spacing from `formatMegabytes` (`units.megabytesShort`
    // renders `{{value}} MB`), same as the other model managers.
    expect(formatModelSize(422)).toBe('422 MB');
    expect(formatModelSize(190)).toBe('190 MB');
    expect(formatModelSize(1549)).toBe('1.5 GB');
  });

  test('carries family and task metadata independently of any engine', () => {
    const diar = diarModel();

    expect(diar.family).toBe('nemotron_3_diar');
    expect(diar.task).toBe('diar');
    expect(diar.quantization).toBe('BF16');
  });
});
