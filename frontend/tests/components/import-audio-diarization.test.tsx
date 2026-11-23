/**
 * The import dialog's bar continues through diarization (ticket 03).
 *
 * The bar must no longer finish at transcription: after the save it holds the
 * diarization band (75..100) fed by the shared pass state, "Done" and 100%
 * appear only on the pass's terminal — or immediately when the frontend knows
 * the pass will never run (no model), and closing the dialog during
 * diarization is allowed and never interrupts the detached pass (the store
 * keeps the state for the speakers panel).
 *
 * Radix Dialog/Select and the sidebar/model/config hooks do not render in
 * bun, so they are replaced with plain containers and fakes; Tauri modules
 * are mocked with an `afterAll` restore that spreads the real module, the
 * pattern the other dialog suites use.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DiarizationPassStore } from '../../src/lib/diarization';
import type { DiarizationAvailabilityClient } from '../../src/lib/diarizationAvailability';

const modules = [
  '../../src/components/ui/dialog',
  '../../src/components/ui/select',
  '../../src/contexts/ConfigContext',
  '../../src/hooks/useTranscriptionModels',
  '../../src/components/Sidebar/SidebarProvider',
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  'next/navigation',
  'sonner',
];
const originals = await Promise.all(
  modules.map(async path => [path, { ...(await import(path)) }] as const),
);
afterAll(() => {
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

const Container = ({ children }: any) => <div>{children}</div>;

/** Captured so a test can act as if the user pressed Escape or clicked away. */
let capturedDialogClose: ((open: boolean) => void) | null = null;

mock.module('../../src/components/ui/dialog', () => ({
  Dialog: ({ open, children, onOpenChange }: any) => {
    capturedDialogClose = onOpenChange;
    return open ? <div>{children}</div> : null;
  },
  DialogContent: Container,
  DialogDescription: Container,
  DialogFooter: Container,
  DialogHeader: Container,
  DialogTitle: Container,
  DialogTrigger: Container,
  DialogClose: Container,
  DialogPortal: Container,
  DialogOverlay: Container,
}));

mock.module('../../src/components/ui/select', () => ({
  Select: Container,
  SelectContent: Container,
  SelectItem: Container,
  SelectTrigger: Container,
  SelectValue: Container,
  SelectGroup: Container,
  SelectLabel: Container,
  SelectSeparator: Container,
}));

mock.module('../../src/contexts/ConfigContext', () => ({
  useConfig: () => ({
    transcriptModelConfig: { provider: 'transcribeCpp', model: 'qwen3-asr-1.7b-Q8_0' },
  }),
}));

mock.module('../../src/hooks/useTranscriptionModels', () => ({
  useTranscriptionModels: () => ({
    availableModels: [],
    selectedModelKey: null,
    setSelectedModelKey: () => {},
    loadingModels: false,
    fetchModels: () => {},
    resetSelection: () => {},
  }),
}));

const refetchMeetings = mock(() => {});
mock.module('../../src/components/Sidebar/SidebarProvider', () => ({
  useSidebar: () => ({ refetchMeetings }),
}));

const routerPush = mock(() => {});
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

const FILE_INFO = {
  path: '/tmp/a.wav',
  filename: 'a',
  duration_seconds: 1,
  size_bytes: 1,
  format: 'WAV',
};

const started: string[] = [];
const cancelled: string[] = [];
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'validate_audio_file_command') return FILE_INFO;
    if (command === 'start_import_audio_command') {
      started.push('import');
      return undefined;
    }
    if (command === 'cancel_import_command') {
      cancelled.push('cancel');
      return undefined;
    }
    return undefined;
  },
}));

type Handler = (event: { payload: Record<string, unknown> }) => void;
const registered = new Map<string, Handler>();
mock.module('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  },
}));

const toastError = mock(() => {});
const toastInfo = mock(() => {});
const toastSuccess = mock(() => {});
const toastWarning = mock(() => {});
mock.module('sonner', () => ({
  toast: { info: toastInfo, error: toastError, success: toastSuccess, warning: toastWarning },
}));

const { ImportAudioDialog } = await import('../../src/components/ImportAudio/ImportAudioDialog');

/** The pass-store bridge, separate from the Tauri event registry. */
function storeHarness() {
  const handlers = new Map<string, Handler>();
  const listen = async (name: string, handler: Handler) => {
    handlers.set(name, handler);
    return () => {
      handlers.delete(name);
    };
  };
  const store = new DiarizationPassStore(listen as never);
  return { store, handlers, listen };
}

function availabilityClient(
  overrides: Partial<DiarizationAvailabilityClient> = {},
): DiarizationAvailabilityClient {
  return {
    getAvailableModels: async () => [
      {
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
      } as any,
    ],
    getDiagnostics: async () =>
      ({ available: true, error: null }) as any,
    isRecording: async () => false,
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
let setDialogOpen: ((open: boolean) => void) | null = null;

function Harness({
  passStore,
  availability,
}: {
  passStore: DiarizationPassStore;
  availability: DiarizationAvailabilityClient;
}) {
  const [open, setOpen] = React.useState(true);
  setDialogOpen = setOpen;
  return (
    <ImportAudioDialog
      open={open}
      onOpenChange={setOpen}
      preselectedFile="/tmp/a.wav"
      passStore={passStore}
      availabilityClient={availability}
    />
  );
}

async function show(harness: ReturnType<typeof storeHarness>, availability: DiarizationAvailabilityClient) {
  await act(async () => {
    renderer = create(<Harness passStore={harness.store} availability={availability} />);
  });
  // The preselected-file validation and the listener registration are async.
  for (let attempt = 0; attempt < 60 && !registered.has('import-complete'); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function flush(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function clickImport() {
  const button = findButton('Import');
  expect(button).toBeDefined();
  await act(async () => {
    button!.onClick();
  });
  await flush();
}

async function emitTauri(name: string, payload: Record<string, unknown>) {
  const handler = registered.get(name);
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload });
  });
  await flush();
}

async function emitStore(harness: ReturnType<typeof storeHarness>, name: string, payload: Record<string, unknown>) {
  const handler = harness.handlers.get(name);
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload });
  });
  await flush();
}

interface Found {
  label: string;
  onClick: () => void;
}

function findButton(label: string): Found | undefined {
  const tree = renderer?.toJSON();
  const out: Found[] = [];
  const walk = (node: any) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node !== 'object') return;
    if (node.type === 'button') {
      const text = JSON.stringify(node.children ?? []).replace(/[^A-Za-z ]/g, '');
      out.push({ label: text, onClick: node.props?.onClick ?? (() => {}) });
    }
    if (node.children) walk(node.children);
  };
  walk(tree);
  return out.find((button) => button.label.includes(label));
}

function renderedText(): string {
  return JSON.stringify(renderer?.toJSON() ?? null);
}

const COMPLETE = {
  meeting_id: 'meeting-imported',
  title: 'Imported',
  segments_count: 2,
  duration_seconds: 3,
};

beforeEach(() => {
  registered.clear();
  started.length = 0;
  cancelled.length = 0;
  capturedDialogClose = null;
  setDialogOpen = null;
  toastError.mockClear();
  toastInfo.mockClear();
  toastSuccess.mockClear();
  toastWarning.mockClear();
  refetchMeetings.mockClear();
  routerPush.mockClear();
});

afterEach(async () => {
  if (renderer) {
    await act(async () => {
      renderer!.unmount();
    });
  }
  renderer = undefined;
});

test('the bar keeps 75 and the diarization sentence after the save, and waits for the pass', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickImport();
  expect(started).toHaveLength(1);

  await emitTauri('import-progress', {
    stage: 'transcribing',
    progress_percentage: 60,
    message: 'Transcribing segment 1 of 2 (1.0s)...',
  });
  expect(renderedText()).toContain('60%');

  await emitTauri('import-complete', COMPLETE);
  // The transcript is saved: the bar holds the diarization band, the list is
  // refreshed, and the meeting is not declared finished yet.
  expect(renderedText()).toContain('75%');
  expect(renderedText()).toContain('Diarizing');
  expect(renderedText()).not.toContain('Done');
  expect(refetchMeetings).toHaveBeenCalled();
  expect(toastSuccess).not.toHaveBeenCalled();

  // The shared pass state drives the stage caption and the honest number.
  // The committed model-load checkpoint reads honestly inside the band: it
  // tops its own stage slice (89) and never reaches 100 mid-pass; the
  // terminal alone releases 100.
  await emitStore(harness, 'diarization-progress', {
    meeting_id: 'meeting-imported',
    stage: 'loading_model',
    progress_percentage: 100,
    message: 'Loading the diarization model...',
  });
  expect(renderedText()).toContain('Loading the model');
  expect(renderedText()).toContain('89%');

  // The terminal releases "Done" and the complete toast.
  await emitStore(harness, 'transcript-updated', {
    meeting_id: 'meeting-imported',
    labeled_segments: 2,
    total_segments: 2,
  });
  expect(renderedText()).toContain('Done');
  expect(renderedText()).toContain('Import complete');
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});

test('the terminal for another meeting does not complete this import', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickImport();
  await emitTauri('import-complete', COMPLETE);

  await emitStore(harness, 'transcript-updated', { meeting_id: 'meeting-other' });

  expect(renderedText()).not.toContain('Done');
  expect(toastSuccess).not.toHaveBeenCalled();
  harness.store.dispose();
});

test('without a diarization model the bar completes right after transcription, silently', async () => {
  // No installed diar model: the pass decision answers `no_model` silently,
  // so the bar must not wait for a terminal that can never arrive — and must
  // not raise an error either (spec story 14).
  const harness = storeHarness();
  const noModel = availabilityClient({ getAvailableModels: async () => [] });
  await show(harness, noModel);
  await clickImport();
  await emitTauri('import-complete', COMPLETE);

  expect(renderedText()).toContain('Done');
  expect(renderedText()).toContain('Import complete');
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  expect(toastError).not.toHaveBeenCalled();
  harness.store.dispose();
});

test('closing during transcription is blocked; closing during diarization is allowed and the pass survives', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickImport();

  // Mid-transcription the dialog refuses to close.
  await emitTauri('import-progress', {
    stage: 'transcribing',
    progress_percentage: 40,
    message: 'Transcribing segment 1 of 2 (1.0s)...',
  });
  expect(capturedDialogClose).not.toBeNull();
  await act(async () => {
    capturedDialogClose!(false);
  });
  await flush();
  expect(renderedText()).toContain('40%'); // still open

  // In the diarization band closing is allowed.
  await emitTauri('import-complete', COMPLETE);
  const closeButton = findButton('Close');
  expect(closeButton).toBeDefined();
  await act(async () => {
    closeButton!.onClick();
  });
  await flush();
  expect(renderer?.toJSON()).toBeNull(); // the dialog closed

  // The detached pass was not interrupted: the shared state keeps its stage
  // for the speakers panel (a progress beat still lands after the close).
  await emitStore(harness, 'diarization-progress', {
    meeting_id: 'meeting-imported',
    stage: 'inferring',
    message: 'Detecting speakers...',
  });
  expect(harness.store.getState('meeting-imported')?.stage).toBe('inferring');

  // The terminal releases completion even though the dialog is closed.
  await emitStore(harness, 'transcript-updated', { meeting_id: 'meeting-imported' });
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});

test('Done closes the dialog and opens the imported meeting', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickImport();
  await emitTauri('import-complete', COMPLETE);
  await emitStore(harness, 'transcript-updated', { meeting_id: 'meeting-imported' });

  const done = findButton('Done');
  expect(done).toBeDefined();
  await act(async () => {
    done!.onClick();
  });
  expect(renderer?.toJSON()).toBeNull();
  expect(routerPush).toHaveBeenCalledWith('/meeting-details?id=meeting-imported');
  harness.store.dispose();
});

test('an import error leaves the bar unfinished', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickImport();

  await emitTauri('import-error', { error: 'decode failed' });

  expect(renderedText()).toContain('decode failed');
  expect(renderedText()).not.toContain('Done');
  expect(toastError).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});
