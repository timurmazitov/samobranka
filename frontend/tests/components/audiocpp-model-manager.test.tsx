import React from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Download notifications are part of the visible behaviour, so the toast
// channel is captured. Bun shares module mocks between files: restore it
// afterwards, matching the other component suites.
const notify = mock((_message: string, _options?: unknown) => {});
mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));
const originalToast = { ...(await import('sonner')) };
afterAll(() => {
  mock.module('sonner', () => originalToast);
});

import type {
  AudioCppCancelDownloadOutcome,
  AudioCppDiagnostics,
  AudioCppDownloadCompleteEvent,
  AudioCppDownloadErrorEvent,
  AudioCppDownloadProgressEvent,
  AudioCppModelClient,
  AudioCppModelInfo,
} from '../../src/lib/audiocpp';

const diarizationModel = (overrides: Partial<AudioCppModelInfo> = {}): AudioCppModelInfo => ({
  name: 'nemotron-3-diarization-bf16',
  display_name: 'Nemotron-3 Diarization',
  family: 'nemotron_3_diar',
  task: 'diar',
  quantization: 'BF16',
  filename: 'nemotron-3-diarization-bf16.gguf',
  path: '/models/audiocpp/nemotron-3-diarization-bf16.gguf',
  size_mb: 190,
  size_bytes: 198720928,
  description: 'Speaker diarization',
  status: 'Missing',
  ...overrides,
});

/** A foreign (non-diarization) entry a stale catalog state could still
 *  report: the manager must never render it — the Rust catalog is
 *  diarization-only now, and transcribe.cpp owns transcription. The cast
 *  only satisfies the diar-only client type; at runtime the task stays 'asr',
 *  which is what the manager's filter sees. */
const asrModel = (overrides: Partial<AudioCppModelInfo> = {}): AudioCppModelInfo => ({
  name: 'gigaam-v3-e2e-ctc-f16',
  display_name: 'GigaAM v3 e2e CTC',
  family: 'gigaam_asr',
  task: 'asr' as unknown as 'diar',
  quantization: 'BF16',
  filename: 'gigaam-v3-e2e-ctc-f16.gguf',
  path: '/models/audiocpp/gigaam-v3-e2e-ctc-f16.gguf',
  size_mb: 422,
  size_bytes: 442520704,
  description: 'Russian speech recognition',
  status: 'Missing',
  ...overrides,
});

const availableRuntime = (): AudioCppDiagnostics => ({
  available: true,
  library_path: '/usr/lib/libaudiocpp.so',
  abi_version: '1',
  build_version: '0.1.0',
  families: ['nemotron_3_diar'],
  tasks: ['diar'],
  error: null,
});

/** Fake native client: records calls and lets the test emit events. */
class FakeClient implements AudioCppModelClient {
  models: AudioCppModelInfo[] = [];
  calls: string[] = [];
  downloadError: Error | null = null;
  cancelOutcome: AudioCppCancelDownloadOutcome = 'cancelled';
  /** Runtime report the fake returns; `null` makes the command fail. */
  diagnostics: AudioCppDiagnostics | null = availableRuntime();

  private progressHandlers: Array<(event: AudioCppDownloadProgressEvent) => void> = [];
  private completeHandlers: Array<(event: AudioCppDownloadCompleteEvent) => void> = [];
  private errorHandlers: Array<(event: AudioCppDownloadErrorEvent) => void> = [];

  async init() { this.calls.push('init'); }
  async getAvailableModels() { this.calls.push('getAvailableModels'); return this.models.map(m => ({ ...m })); }
  async hasAvailableModels() { return this.models.some(m => m.status === 'Available'); }
  async getModelsDirectory() { return '/models/audiocpp'; }
  async openModelsFolder() { this.calls.push('openModelsFolder'); }

  async getDiagnostics() {
    this.calls.push('getDiagnostics');
    if (!this.diagnostics) throw new Error('diagnostics failed');
    return this.diagnostics;
  }

  async downloadModel(modelName: string) {
    this.calls.push(`download:${modelName}`);
    if (this.downloadError) throw this.downloadError;
  }

  async cancelDownload(modelName: string) {
    this.calls.push(`cancel:${modelName}`);
    return this.cancelOutcome;
  }

  async deleteModel(modelName: string) {
    this.calls.push(`delete:${modelName}`);
    this.models = this.models.map(model =>
      model.name === modelName ? { ...model, status: 'Missing' as const } : model
    );
    return 'deleted';
  }

  async listenProgress(handler: (event: AudioCppDownloadProgressEvent) => void) {
    this.progressHandlers.push(handler);
    return () => { this.progressHandlers = this.progressHandlers.filter(h => h !== handler); };
  }

  async listenComplete(handler: (event: AudioCppDownloadCompleteEvent) => void) {
    this.completeHandlers.push(handler);
    return () => { this.completeHandlers = this.completeHandlers.filter(h => h !== handler); };
  }

  async listenError(handler: (event: AudioCppDownloadErrorEvent) => void) {
    this.errorHandlers.push(handler);
    return () => { this.errorHandlers = this.errorHandlers.filter(h => h !== handler); };
  }

  emitProgress(event: AudioCppDownloadProgressEvent) {
    for (const handler of [...this.progressHandlers]) handler(event);
  }
  emitComplete(event: AudioCppDownloadCompleteEvent) {
    for (const handler of [...this.completeHandlers]) handler(event);
  }
  emitError(event: AudioCppDownloadErrorEvent) {
    for (const handler of [...this.errorHandlers]) handler(event);
  }
}

const { AudioCppModelManager } = await import('../../src/components/AudioCppModelManager');

let renderer: ReactTestRenderer | undefined;

async function render(
  client: FakeClient,
  props: Partial<React.ComponentProps<typeof AudioCppModelManager>> = {},
) {
  await act(async () => {
    renderer = create(<AudioCppModelManager client={client} {...props} />);
  });
  return renderer!;
}

function textOf(node: ReactTestRenderer) {
  function stringify(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) return value.map(stringify).join('');
    const element = value as { children?: unknown; props?: { children?: unknown } };
    return stringify(element.children) + stringify(element.props?.children);
  }
  return stringify(node.toJSON());
}

function buttonWithText(root: ReactTestRenderer, text: string) {
  return root.root.findAllByType('button')
    .find(button => JSON.stringify(button.children).includes(text));
}

/** Click a node the way React would: with an event that can stop propagation. */
function click(node: { props: { onClick?: (event: unknown) => void } }) {
  node.props.onClick?.({ stopPropagation() {} });
}

/** Cards currently rendered, in catalog order. */
function modelCards(view: ReactTestRenderer) {
  return view.root.findAll(node =>
    typeof node.props?.['data-testid'] === 'string'
    && typeof node.props?.['data-model-task'] === 'string');
}

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

test('lists the diarization model with its purpose and size', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];

  const text = textOf(await render(client));

  expect(client.calls).toContain('init');
  expect(text).toContain('Nemotron-3 Diarization');
  expect(text).toContain('Diarization');
  expect(text).toContain('190 MB');
  expect(text).toContain('BF16');
});

test('the card renders the localized description, not the Rust prose', async () => {
  // native-i18n ticket 04: the description comes from
  // `models.audioCpp.descriptions.<family>` (the `taskLabel()` precedent);
  // a card still rendering `model.description` (the sentinel below) fails.
  const client = new FakeClient();
  client.models = [diarizationModel({ description: 'RUST FALLBACK PROSE' })];

  const text = textOf(await render(client));

  expect(text).toContain('Speaker diarization (Nemotron-3');
  expect(text).not.toContain('RUST FALLBACK PROSE');
});

test('a foreign ASR entry never renders: transcription belongs to transcribe.cpp', async () => {
  const client = new FakeClient();
  client.models = [asrModel(), diarizationModel()];

  const view = await render(client);

  expect(modelCards(view).map(card => card.props['data-testid']))
    .toEqual(['audiocpp-model-nemotron-3-diarization-bf16']);
  expect(textOf(view)).not.toContain('GigaAM v3 e2e CTC');
});

test('the manager offers no selection: a diarization model cannot transcribe', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel({ status: 'Available' })];

  const view = await render(client);

  const card = view.root.findByProps({ 'data-testid': 'audiocpp-model-nemotron-3-diarization-bf16' });
  expect(card.props.onClick).toBeUndefined();
  expect(card.props['data-model-selected']).toBeUndefined();
});

test('downloading the model invokes the download command and shows progress', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];
  const view = await render(client);

  const download = buttonWithText(view, 'Download');
  expect(download).toBeDefined();
  await act(async () => { click(download!); });

  expect(client.calls).toContain('download:nemotron-3-diarization-bf16');

  await act(async () => {
    client.emitProgress({
      modelName: 'nemotron-3-diarization-bf16',
      progress: 42,
      status: 'downloading',
    });
  });
  expect(textOf(view)).toContain('42%');

  await act(async () => {
    client.emitComplete({ modelName: 'nemotron-3-diarization-bf16' });
  });
  expect(textOf(view)).toContain('Ready');
});

test('a failed download surfaces the error and offers a retry', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];
  client.downloadError = new Error('Download failed');
  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });

  expect(textOf(view)).toContain('Retry');
});

test('cancelling an in-flight download calls the cancel command', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];
  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });
  await act(async () => {
    client.emitProgress({
      modelName: 'nemotron-3-diarization-bf16',
      progress: 10,
      status: 'downloading',
    });
  });

  const cancel = buttonWithText(view, 'Cancel');
  expect(cancel).toBeDefined();
  await act(async () => { click(cancel!); });
  expect(client.calls).toContain('cancel:nemotron-3-diarization-bf16');

  await act(async () => {
    client.emitProgress({
      modelName: 'nemotron-3-diarization-bf16',
      progress: 0,
      status: 'cancelled',
    });
  });
  expect(textOf(view)).toContain('Download');
});

test('an installed model can be deleted', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel({ status: 'Available' })];
  const view = await render(client);

  expect(textOf(view)).toContain('Ready');

  const card = view.root.findByProps({ 'data-testid': 'audiocpp-model-nemotron-3-diarization-bf16' });
  await act(async () => { card.props.onMouseEnter(); });

  const del = view.root.findAllByType('button')
    .find(button => typeof button.props['aria-label'] === 'string'
      && button.props['aria-label'].startsWith('Delete'));
  expect(del).toBeDefined();
  await act(async () => { click(del!); });

  expect(client.calls).toContain('delete:nemotron-3-diarization-bf16');
  expect(textOf(view)).toContain('Download');
});

test('an installed model survives a restart: state comes from the native catalog', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel({ status: 'Available' })];

  const first = textOf(await render(client));
  expect(first).toContain('Ready');
  await act(async () => renderer!.unmount());
  renderer = undefined;

  // A fresh mount re-reads the persisted state instead of assuming Missing.
  const restarted = textOf(await render(client));
  expect(restarted).toContain('Ready');
});

test('a corrupted artifact can be deleted or re-downloaded', async () => {
  const client = new FakeClient();
  client.models = [
    diarizationModel({ status: { Corrupted: { file_size: 3, expected_min_size: 198720928 } } }),
  ];
  const view = await render(client);

  const text = textOf(view);
  expect(text).toContain('Delete');
  expect(text).toContain('Re-download');
});

const unavailableRuntime = (error: string): AudioCppDiagnostics => ({
  available: false,
  library_path: null,
  abi_version: null,
  build_version: null,
  families: [],
  tasks: [],
  error,
});

test('the section warns when the native runtime is unavailable, and the model stays downloadable', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];
  client.diagnostics = unavailableRuntime('libaudiocpp not found via AUDIOCPP_LIBRARY_PATH');

  const view = await render(client);
  const text = textOf(view);

  expect(text).toContain('Diarization engine is unavailable on this system');
  // The underlying reason lives in the hover tooltip, not in the headline.
  const warning = view.root.find(node =>
    typeof node.props?.title === 'string'
    && node.props.title.includes('AUDIOCPP_LIBRARY_PATH'));
  expect(warning).toBeDefined();

  // Explaining why the engine will not run must not block preparing the model.
  expect(buttonWithText(view, 'Download')).toBeDefined();
  await act(async () => { click(buttonWithText(view, 'Download')!); });
  expect(client.calls).toContain('download:nemotron-3-diarization-bf16');
});

test('no runtime warning is shown when the native library is available', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];
  client.diagnostics = availableRuntime();

  const view = await render(client);

  expect(textOf(view)).not.toContain('unavailable on this system');
});

test('events for a model this manager does not list are not announced', async () => {
  // A foreign model's download events (e.g. a stale ASR entry reported by an
  // old catalog state) must not surface in the diarization section.
  const client = new FakeClient();
  client.models = [asrModel(), diarizationModel()];
  await render(client);
  notify.mockClear();

  await act(async () => {
    client.emitComplete({ modelName: 'gigaam-v3-e2e-ctc-f16' });
  });
  expect(notify.mock.calls.filter(call => String(call[0]).includes('GigaAM'))).toHaveLength(0);

  await act(async () => {
    client.emitComplete({ modelName: 'nemotron-3-diarization-bf16' });
  });
  expect(notify.mock.calls.filter(call => String(call[0]).includes('Nemotron-3 Diarization')))
    .toHaveLength(1);
});

test('the section downloads, cancels, deletes and re-downloads its model', async () => {
  const client = new FakeClient();
  client.models = [diarizationModel()];

  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });
  expect(client.calls).toContain('download:nemotron-3-diarization-bf16');

  await act(async () => {
    client.emitProgress({
      modelName: 'nemotron-3-diarization-bf16',
      progress: 25,
      status: 'downloading',
    });
  });
  expect(textOf(view)).toContain('25%');

  await act(async () => { click(buttonWithText(view, 'Cancel')!); });
  expect(client.calls).toContain('cancel:nemotron-3-diarization-bf16');

  await act(async () => {
    client.emitProgress({
      modelName: 'nemotron-3-diarization-bf16',
      progress: 0,
      status: 'cancelled',
    });
  });
  expect(textOf(view)).toContain('Download');

  // Finished download: the card is ready and can be deleted again.
  await act(async () => { click(buttonWithText(view, 'Download')!); });
  await act(async () => { client.emitComplete({ modelName: 'nemotron-3-diarization-bf16' }); });
  expect(textOf(view)).toContain('Ready');

  const card = view.root.findByProps({ 'data-testid': 'audiocpp-model-nemotron-3-diarization-bf16' });
  await act(async () => { card.props.onMouseEnter(); });
  const del = view.root.findAllByType('button')
    .find(button => typeof button.props['aria-label'] === 'string'
      && button.props['aria-label'].startsWith('Delete'));
  await act(async () => { click(del!); });

  expect(client.calls).toContain('delete:nemotron-3-diarization-bf16');
  expect(textOf(view)).toContain('Download');
});
