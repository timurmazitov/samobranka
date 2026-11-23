import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Download notifications are part of the visible behaviour, so the toast
// channel is captured. Bun shares module mocks between files: capture the
// pristine exports BEFORE installing any mock (an "original" snapshot taken
// after mocking would restore the stub itself), re-apply the fake before
// every test in case a sibling suite restored or replaced it in between, and
// restore in afterAll.
const originalToast = { ...(await import('sonner')) };

const notify = mock((_message: string, _options?: unknown) => {});
const mockToast = () => mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));
mockToast();
beforeEach(() => {
  mockToast();
});

afterAll(() => {
  mock.module('sonner', () => originalToast);
});

import type {
  TranscribeCppCancelDownloadOutcome,
  TranscribeCppDownloadCompleteEvent,
  TranscribeCppDownloadErrorEvent,
  TranscribeCppDownloadProgressEvent,
  TranscribeCppModelClient,
  TranscribeCppModelInfo,
} from '../../src/lib/transcribeCpp';

const baseModel = (overrides: Partial<TranscribeCppModelInfo> = {}): TranscribeCppModelInfo => ({
  name: 'parakeet-ultra-Q8_0',
  display_name: 'Parakeet Ultra',
  family: 'parakeet-ultra',
  quantization: 'Q8_0',
  filename: 'parakeet-ultra-Q8_0.gguf',
  path: '/models/transcribecpp/parakeet-ultra-Q8_0.gguf',
  size_mb: 706,
  size_bytes: 740363168,
  description: 'Multilingual speech recognition (Parakeet Ultra).',
  sha256: '007a59761e9258779f189df396b50d12b83bb5b79e66df4b955c230d2f2a0a59',
  status: 'Missing',
  ...overrides,
});

/** Fake native client: records calls and lets the test emit events. */
class FakeClient implements TranscribeCppModelClient {
  models: TranscribeCppModelInfo[] = [];
  calls: string[] = [];
  downloadError: Error | null = null;
  cancelOutcome: TranscribeCppCancelDownloadOutcome = 'cancelled';

  private progressHandlers: Array<(event: TranscribeCppDownloadProgressEvent) => void> = [];
  private completeHandlers: Array<(event: TranscribeCppDownloadCompleteEvent) => void> = [];
  private errorHandlers: Array<(event: TranscribeCppDownloadErrorEvent) => void> = [];

  async init() { this.calls.push('init'); }
  async getAvailableModels() { this.calls.push('getAvailableModels'); return this.models.map(m => ({ ...m })); }
  async hasAvailableModels() { return this.models.some(m => m.status === 'Available'); }
  async hasTranscriptionModel() {
    return this.models.some(m => m.status === 'Available');
  }
  async getModelsDirectory() { return '/models/transcribecpp'; }
  async openModelsFolder() { this.calls.push('openModelsFolder'); }

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

  async listenProgress(handler: (event: TranscribeCppDownloadProgressEvent) => void) {
    this.progressHandlers.push(handler);
    return () => { this.progressHandlers = this.progressHandlers.filter(h => h !== handler); };
  }

  async listenComplete(handler: (event: TranscribeCppDownloadCompleteEvent) => void) {
    this.completeHandlers.push(handler);
    return () => { this.completeHandlers = this.completeHandlers.filter(h => h !== handler); };
  }

  async listenError(handler: (event: TranscribeCppDownloadErrorEvent) => void) {
    this.errorHandlers.push(handler);
    return () => { this.errorHandlers = this.errorHandlers.filter(h => h !== handler); };
  }

  emitProgress(event: TranscribeCppDownloadProgressEvent) {
    for (const handler of [...this.progressHandlers]) handler(event);
  }
  emitComplete(event: TranscribeCppDownloadCompleteEvent) {
    for (const handler of [...this.completeHandlers]) handler(event);
  }
  emitError(event: TranscribeCppDownloadErrorEvent) {
    for (const handler of [...this.errorHandlers]) handler(event);
  }
}

// Re-evaluate the manager under THIS file's mocks before every test: Bun
// loads all test files before running any, so a module imported at load time
// would keep whichever invoke the shared registry happened to hold then —
// possibly a foreign fake. A fresh query string each test forces a fresh
// link against the mock installed by beforeEach. The specifier is a variable
// so TypeScript does not try to resolve the cache-busting query.
type ManagerModule = typeof import('../../src/components/TranscribeCppModelManager');
let TranscribeCppModelManager: ManagerModule['TranscribeCppModelManager'];
let moduleNonce = 0;
beforeEach(async () => {
  moduleNonce += 1;
  const managerPath = `../../src/components/TranscribeCppModelManager?v=tcp-04-${moduleNonce}`;
  const managerModule: ManagerModule = await import(managerPath);
  TranscribeCppModelManager = managerModule.TranscribeCppModelManager;
});

let renderer: ReactTestRenderer | undefined;

async function render(
  client: FakeClient,
  props: Partial<React.ComponentProps<typeof TranscribeCppModelManager>> = {},
) {
  await act(async () => {
    renderer = create(<TranscribeCppModelManager client={client} {...props} />);
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

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

test('lists every catalogued model with its purpose and size', async () => {
  const client = new FakeClient();
  client.models = [
    baseModel(),
    baseModel({
      name: 'gigaam-v3-e2e-ctc-Q4_K_M',
      display_name: 'GigaAM v3 e2e CTC',
      family: 'gigaam-v3-e2e-ctc',
      quantization: 'Q4_K_M',
      filename: 'gigaam-v3-e2e-ctc-Q4_K_M.gguf',
      size_mb: 174,
      size_bytes: 182497888,
      description: 'Russian speech recognition (GigaAM v3 end-to-end CTC).',
    }),
  ];

  const text = textOf(await render(client));

  expect(client.calls).toContain('init');
  expect(text).toContain('Parakeet Ultra');
  expect(text).toContain('GigaAM v3 e2e CTC');
  expect(text).toContain('706 MB');
  expect(text).toContain('174 MB');
  expect(text).toContain('Q8_0');
  expect(text).toContain('Q4_K_M');
});

test('the card renders the localized description and quantization note, not the Rust prose', async () => {
  // native-i18n ticket 04: the description comes from
  // `models.transcribeCpp.descriptions.<family>` and the quantization note —
  // the sentence the Rust catalog macro used to append — from the frontend
  // key next to the badge. A card still rendering `model.description` (the
  // sentinel below) or missing the note must fail here.
  const client = new FakeClient();
  client.models = [baseModel({ description: 'RUST FALLBACK PROSE' })];

  const text = textOf(await render(client));

  expect(text).toContain('Multilingual speech recognition (Parakeet Ultra)');
  expect(text).not.toContain('RUST FALLBACK PROSE');
  expect(text).toContain('Quantization: Q8_0.');
});

test('downloading a model invokes the download command and shows progress', async () => {
  const client = new FakeClient();
  client.models = [baseModel()];
  const view = await render(client);

  const download = buttonWithText(view, 'Download');
  expect(download).toBeDefined();
  await act(async () => { click(download!); });

  expect(client.calls).toContain('download:parakeet-ultra-Q8_0');

  await act(async () => {
    client.emitProgress({
      modelName: 'parakeet-ultra-Q8_0',
      progress: 42,
      status: 'downloading',
    });
  });
  expect(textOf(view)).toContain('42%');

  await act(async () => {
    client.emitComplete({ modelName: 'parakeet-ultra-Q8_0' });
  });
  expect(textOf(view)).toContain('Ready');
});

test('a failed download surfaces the error and offers a retry', async () => {
  const client = new FakeClient();
  client.models = [baseModel()];
  client.downloadError = new Error('Download failed');
  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });

  expect(textOf(view)).toContain('Retry');
});

test('a download error event marks the model as failed', async () => {
  const client = new FakeClient();
  client.models = [baseModel()];
  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });
  await act(async () => {
    client.emitError({ modelName: 'parakeet-ultra-Q8_0', error: 'checksum mismatch' });
  });

  expect(textOf(view)).toContain('Retry');
  const messages = notify.mock.calls.map(call => call[0]);
  expect(messages.some(message => message.includes('Parakeet Ultra'))).toBeTrue();
});

test('cancelling an in-flight download calls the cancel command', async () => {
  const client = new FakeClient();
  client.models = [baseModel()];
  const view = await render(client);

  await act(async () => { click(buttonWithText(view, 'Download')!); });
  await act(async () => {
    client.emitProgress({
      modelName: 'parakeet-ultra-Q8_0',
      progress: 10,
      status: 'downloading',
    });
  });

  const cancel = buttonWithText(view, 'Cancel');
  expect(cancel).toBeDefined();
  await act(async () => { click(cancel!); });
  expect(client.calls).toContain('cancel:parakeet-ultra-Q8_0');

  await act(async () => {
    client.emitProgress({
      modelName: 'parakeet-ultra-Q8_0',
      progress: 0,
      status: 'cancelled',
    });
  });
  expect(textOf(view)).toContain('Download');
});

test('an installed model can be deleted', async () => {
  const client = new FakeClient();
  client.models = [baseModel({ status: 'Available' })];
  const view = await render(client);

  expect(textOf(view)).toContain('Ready');

  const card = view.root.findByProps({ 'data-testid': 'transcribecpp-model-parakeet-ultra-Q8_0' });
  await act(async () => { card.props.onMouseEnter(); });

  const del = view.root.findAllByType('button')
    .find(button => typeof button.props['aria-label'] === 'string'
      && button.props['aria-label'].startsWith('Delete'));
  expect(del).toBeDefined();
  await act(async () => { click(del!); });

  expect(client.calls).toContain('delete:parakeet-ultra-Q8_0');
  expect(textOf(view)).toContain('Download');
});

test('an installed model survives a restart: state comes from the native catalog', async () => {
  const client = new FakeClient();
  client.models = [baseModel({ status: 'Available' })];

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
    baseModel({ status: { Corrupted: { file_size: 3, expected_min_size: 740363168 } } }),
  ];
  const view = await render(client);

  const text = textOf(view);
  expect(text).toContain('Delete');
  expect(text).toContain('Re-download');
});

test('an installed model can be selected from the settings', async () => {
  const client = new FakeClient();
  client.models = [baseModel({ status: 'Available' })];
  const selected: string[] = [];
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <TranscribeCppModelManager client={client} onModelSelect={name => selected.push(name)} />,
    );
  });
  renderer = view!;

  const card = view!.root.findByProps({ 'data-testid': 'transcribecpp-model-parakeet-ultra-Q8_0' });
  expect(card.props['data-model-selected']).toBe('true');

  await act(async () => { click(card); });
  // Already selected: a click must not re-trigger the save path.
  expect(selected).toEqual([]);
});

test('selecting another model reports it to the settings', async () => {
  const client = new FakeClient();
  client.models = [
    baseModel({ status: 'Available' }),
    baseModel({ name: 'gigaam-v3-ctc-Q8_0', display_name: 'GigaAM v3 CTC', status: 'Available' }),
  ];
  const selected: string[] = [];
  await act(async () => {
    renderer = create(
      <TranscribeCppModelManager
        client={client}
        selectedModel="parakeet-ultra-Q8_0"
        onModelSelect={name => selected.push(name)}
      />,
    );
  });

  const other = renderer!.root.findByProps({ 'data-testid': 'transcribecpp-model-gigaam-v3-ctc-Q8_0' });
  await act(async () => { click(other); });

  expect(selected).toEqual(['gigaam-v3-ctc-Q8_0']);
});

test('autoSave persists the selection as the transcribeCpp provider config', async () => {
  const client = new FakeClient();
  client.models = [
    baseModel({ status: 'Available' }),
    baseModel({ name: 'gigaam-v3-ctc-Q8_0', display_name: 'GigaAM v3 CTC', status: 'Available' }),
  ];
  const saved: Array<{ provider: string; model: string; apiKey: null }> = [];
  await act(async () => {
    renderer = create(
      <TranscribeCppModelManager
        client={client}
        selectedModel="parakeet-ultra-Q8_0"
        onModelSelect={() => {}}
        autoSave={true}
        saveSelection={async config => { saved.push(config); }}
      />,
    );
  });

  const other = renderer!.root.findByProps({ 'data-testid': 'transcribecpp-model-gigaam-v3-ctc-Q8_0' });
  await act(async () => { click(other); });

  expect(saved).toHaveLength(1);
  expect(saved[0]).toEqual({
    provider: 'transcribeCpp',
    model: 'gigaam-v3-ctc-Q8_0',
    apiKey: null,
  });
});

test('a missing native library does not block listing or downloading models', async () => {
  // The manager commands never load the native library: with no diagnostics
  // seam at all, the catalog still renders and downloads stay available.
  const client = new FakeClient();
  client.models = [baseModel()];
  const view = await render(client);

  expect(textOf(view)).not.toContain('unavailable');
  await act(async () => { click(buttonWithText(view, 'Download')!); });
  expect(client.calls).toContain('download:parakeet-ultra-Q8_0');
});
