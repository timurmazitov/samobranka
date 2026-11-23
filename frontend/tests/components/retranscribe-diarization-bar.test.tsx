/**
 * The retranscription dialog's bar continues through diarization (ticket 05).
 *
 * The bar must no longer finish at transcription: after the save it holds the
 * diarization band (75..100) fed by the shared pass state, "Done" and 100%
 * appear only on the pass's terminal — or immediately when the frontend knows
 * the pass will never run (no model / no runtime), and closing the dialog
 * during diarization is allowed and never interrupts the detached pass: the
 * shared store keeps the state for the speakers panel after the close
 * (regression: the pass must outlive this dialog).
 *
 * The shape mirrors the import dialog's suite (`import-audio-diarization`):
 * Radix Dialog/Select and the model/config hooks do not render in bun, so
 * they are replaced with plain containers and fakes; the Tauri and sonner
 * modules are mocked with an `afterAll` restore that spreads the real module.
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
  '@tauri-apps/api/event',
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
    transcriptModelConfig: { provider: 'transcribeCpp', model: 'parakeet-ultra-Q8_0' },
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

const started: string[] = [];
const cancelled: string[] = [];
// The dialog's two commands go through the injected `invokeImpl` seam (the
// diarization seam pattern), not the bun module registry: a sibling suite
// (`paginated-transcripts`) leaves `@tauri-apps/api/core` in a state where a
// later `mock.module` for it is ignored, and the import-dialog suite shows
// exactly that failure mode. Injecting keeps this suite order-independent.
const invokeImpl = mock(async (command: string) => {
  if (command === 'start_retranscription_command') {
    started.push('retranscription');
    return undefined;
  }
  if (command === 'cancel_retranscription_command') {
    cancelled.push('cancel');
    return undefined;
  }
  return undefined;
});

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

const { RetranscribeDialog } = await import(
  '../../src/components/MeetingDetails/RetranscribeDialog'
);

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
  return { store, handlers };
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
    getDiagnostics: async () => ({ available: true, error: null }) as any,
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
    <RetranscribeDialog
      open={open}
      onOpenChange={setOpen}
      meetingId="meeting-a"
      meetingFolderPath="/tmp/meeting-a"
      passStore={passStore}
      availabilityClient={availability}
      invokeImpl={invokeImpl as any}
    />
  );
}

async function show(harness: ReturnType<typeof storeHarness>, availability: DiarizationAvailabilityClient) {
  await act(async () => {
    renderer = create(<Harness passStore={harness.store} availability={availability} />);
  });
  // The listener registration is async.
  for (let attempt = 0; attempt < 60 && !registered.has('retranscription-complete'); attempt += 1) {
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

async function clickStart() {
  const button = findButton('Start Retranscription');
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

async function emitStore(
  harness: ReturnType<typeof storeHarness>,
  name: string,
  payload: Record<string, unknown>,
) {
  // The store attaches its bridge on the first subscription; wait it out.
  await harness.store.settled();
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
  meeting_id: 'meeting-a',
  segments_count: 2,
  duration_seconds: 3,
  language: 'en',
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
  await clickStart();
  expect(started).toHaveLength(1);

  await emitTauri('retranscription-progress', {
    ...COMPLETE,
    stage: 'transcribing',
    progress_percentage: 60,
    message: 'Transcribing segment 1 of 2 (1.0s)...',
  });
  expect(renderedText()).toContain('60%');

  await emitTauri('retranscription-complete', COMPLETE);
  // The transcript is saved: the bar holds the diarization band and the
  // meeting is not declared finished yet — no "Done", no complete toast.
  expect(renderedText()).toContain('75%');
  expect(renderedText()).toContain('Diarizing');
  expect(renderedText()).not.toContain('Done');
  expect(toastSuccess).not.toHaveBeenCalled();

  // The shared pass state drives the stage caption and the honest number.
  // The committed model-load checkpoint reads honestly inside the band: it
  // tops its own stage slice (89) and never reaches 100 mid-pass; the
  // terminal alone releases 100.
  await emitStore(harness, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'loading_model',
    progress_percentage: 100,
    message: 'Loading the diarization model...',
  });
  expect(renderedText()).toContain('Loading the model');
  expect(renderedText()).toContain('89%');

  // The terminal releases "Done" and the complete toast.
  await emitStore(harness, 'transcript-updated', {
    meeting_id: 'meeting-a',
    labeled_segments: 2,
    total_segments: 2,
  });
  expect(renderedText()).toContain('Done');
  expect(renderedText()).toContain('Retranscription complete');
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});

test('the terminal for another meeting does not complete this retranscription', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickStart();
  await emitTauri('retranscription-complete', COMPLETE);

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
  await clickStart();
  await emitTauri('retranscription-complete', COMPLETE);

  expect(renderedText()).toContain('Done');
  expect(renderedText()).toContain('Retranscription complete');
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  expect(toastError).not.toHaveBeenCalled();
  harness.store.dispose();
});

test('closing during transcription is blocked; closing during diarization is allowed and the pass survives', async () => {
  // Regression for ticket 05: closing the dialog during the pass must not
  // interrupt it — the shared store keeps announcing the stages, and the
  // terminal still releases the completion.
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickStart();

  // Mid-transcription the dialog refuses to close.
  await emitTauri('retranscription-progress', {
    ...COMPLETE,
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
  await emitTauri('retranscription-complete', COMPLETE);
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
    meeting_id: 'meeting-a',
    stage: 'inferring',
    message: 'Detecting speakers...',
  });
  expect(harness.store.getState('meeting-a')?.stage).toBe('inferring');

  // The terminal releases completion even though the dialog is closed.
  await emitStore(harness, 'transcript-updated', { meeting_id: 'meeting-a' });
  expect(toastSuccess).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});

test('Cancel during transcription still cancels the retranscription and closes', async () => {
  // The dialog's own retranscription stays cancellable; there is no
  // diarization cancel and none was added.
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickStart();
  await emitTauri('retranscription-progress', {
    ...COMPLETE,
    stage: 'transcribing',
    progress_percentage: 40,
    message: 'Transcribing segment 1 of 2 (1.0s)...',
  });

  const cancelButton = findButton('Cancel');
  expect(cancelButton).toBeDefined();
  await act(async () => {
    cancelButton!.onClick();
  });
  await flush();
  expect(cancelled).toEqual(['cancel']);
  expect(renderer?.toJSON()).toBeNull();
  expect(toastInfo).toHaveBeenCalledTimes(1);
  harness.store.dispose();
});

test('an error after the save leaves the bar unfinished and silent about a pass', async () => {
  const harness = storeHarness();
  await show(harness, availabilityClient());
  await clickStart();
  await emitTauri('retranscription-complete', COMPLETE);

  await emitTauri('retranscription-error', { meeting_id: 'meeting-a', error: 'db failed' });

  expect(renderedText()).toContain('db failed');
  expect(renderedText()).not.toContain('Done');
  expect(toastSuccess).not.toHaveBeenCalled();
  harness.store.dispose();
});
