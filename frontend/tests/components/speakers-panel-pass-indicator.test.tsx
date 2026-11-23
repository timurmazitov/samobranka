/**
 * The pass indicator the speakers panel shows for a running diarization
 * pass — automatic or manual alike.
 *
 * The panel reads the shared pass state from the seam store (one listener
 * serves every surface), so these tests drive the store with fake
 * `diarization-progress` events and assert what the panel renders: the
 * current stage with a spinner, the honest percentage where there is one,
 * and a disabled manual-run button while a pass runs.
 *
 * The Radix sheet/popover/command stack and sonner are replaced with plain
 * containers, matching the other panel suite; the panel's diarization seams
 * are injected directly, so no Tauri module mocks leak.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const Container = ({ children }: any) => <div>{children}</div>;

const sheetMock = () => ({
  Sheet: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  SheetContent: Container,
  SheetHeader: Container,
  SheetFooter: Container,
  SheetTitle: Container,
  SheetDescription: Container,
  SheetClose: Container,
  SheetTrigger: Container,
  SheetPortal: Container,
  SheetOverlay: Container,
});
mock.module('../../src/components/ui/sheet', sheetMock);
const originalSheet = { ...(await import('../../src/components/ui/sheet')) };
afterAll(() => {
  mock.module('../../src/components/ui/sheet', () => originalSheet);
});

const popoverMock = () => ({
  Popover: Container,
  PopoverTrigger: Container,
  PopoverContent: Container,
  PopoverAnchor: Container,
});
mock.module('../../src/components/ui/popover', popoverMock);
const originalPopover = { ...(await import('../../src/components/ui/popover')) };
afterAll(() => {
  mock.module('../../src/components/ui/popover', () => originalPopover);
});

const commandMock = () => ({
  Command: Container,
  CommandInput: Container,
  CommandList: Container,
  CommandEmpty: Container,
  CommandGroup: Container,
  CommandItem: Container,
  CommandSeparator: Container,
  CommandShortcut: Container,
});
mock.module('../../src/components/ui/command', commandMock);
const originalCommand = { ...(await import('../../src/components/ui/command')) };
afterAll(() => {
  mock.module('../../src/components/ui/command', () => originalCommand);
});

const notify = mock(() => {});
const toastMock = () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
});
mock.module('sonner', toastMock);
const originalToast = { ...(await import('sonner')) };
afterAll(() => {
  mock.module('sonner', () => originalToast);
});

const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meeting_speakers') return speakers;
  if (command === 'api_get_speaker_names') return [];
  throw new Error(`Unexpected command: ${command}`);
});
const originalCore = { ...(await import('@tauri-apps/api/core')) };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
});
const coreMock = () => ({ ...originalCore, invoke });
mock.module('@tauri-apps/api/core', coreMock);

const { SpeakersPanel } = await import('../../src/components/MeetingDetails/SpeakersPanel');
const { DiarizationPassStore } = await import('../../src/lib/diarization');
const en = (await import('../../src/i18n/locales/en/translation.json')).default;

type DiarizationResult = import('../../src/lib/diarization').DiarizationResult;
type AudioCppModelInfo = import('../../src/lib/audiocpp').AudioCppModelInfo;

let speakers: import('../../src/types').MeetingSpeaker[] = [];

function diarizationModel(): AudioCppModelInfo {
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
    status: 'Available',
  };
}

let availableModels: AudioCppModelInfo[] = [diarizationModel()];
const modelClient = { getAvailableModels: async () => availableModels };

let diarizeStarted: () => void = () => {};
let finishDiarize: (result: DiarizationResult) => void = () => {};
const diarizationClient = {
  diarizeMeeting: (_meetingId: string) =>
    new Promise<DiarizationResult>((resolve) => {
      diarizeStarted();
      finishDiarize = resolve;
    }),
};

/** The fake bridge injected into the seam store. */
function fakeListen() {
  const registered = new Map<string, (event: { payload: never }) => void>();
  const listen = async (name: string, handler: (event: { payload: never }) => void) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  };
  return { registered, listen };
}

let renderer: ReactTestRenderer | undefined;

async function renderPanel(passStore: InstanceType<typeof DiarizationPassStore>) {
  await act(async () => {
    renderer = create(
      <SpeakersPanel
        open
        onOpenChange={() => {}}
        meetingId="meeting-a"
        onRefetchTranscripts={async () => {}}
        diarizationClient={diarizationClient}
        modelClient={modelClient}
        passStore={passStore}
      />,
    );
  });
  return renderer!;
}

function nodeText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node?.children) return node.children.map(nodeText).join('');
  return '';
}

function text(instance: ReactTestRenderer): string {
  return nodeText(instance.toJSON());
}

function diarizeButton(instance: ReactTestRenderer) {
  return instance.root.find(
    (n) => n.props?.['data-testid'] === 'diarize-meeting-button',
  );
}

async function emit(bridge: ReturnType<typeof fakeListen>, name: string, payload: Record<string, unknown>) {
  const handler = bridge.registered.get(name);
  expect(handler, `listener for ${name}`).toBeDefined();
  // Synchronous act: the store notifies listeners synchronously, so React
  // flushes the indicator update without an async boundary. (An async act
  // here leaves the shared react-test act queue mid-drain and bleeds into a
  // later suite.)
  act(() => {
    handler!({ payload } as never);
  });
  await Promise.resolve();
}

beforeEach(() => {
  // Keep this file's fakes authoritative for its own renders, matching the
  // sibling speakers-panel suite: bun shares one module-registry across all
  // files, so a co-loaded suite may have replaced the Tauri core module. The
  // real `invoke` reads `window.__TAURI_INTERNALS__.invoke`, so the shim plus
  // the re-registered core make the panel's load calls land on this file's
  // router regardless of which sibling ran last.
  mock.module('@tauri-apps/api/core', coreMock);
  (globalThis as any).window = {
    __TAURI_INTERNALS__: { invoke },
    dispatchEvent: () => true,
  };
  speakers = [];
  availableModels = [diarizationModel()];
  invoke.mockClear();
  notify.mockClear();
});

afterEach(() => {
  delete (globalThis as any).window;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

test('an automatic pass shows its stage with a spinner next to the run button', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'inferring',
    message: 'Detecting speakers...',
  });

  expect(text(instance)).toContain(en.speakers.stages.inferring);
  // Indeterminate: a spinner, no invented number.
  const indicator = instance.root.find(
    (n) => n.props?.['data-testid'] === 'diarization-pass-indicator',
  );
  expect(indicator).toBeDefined();
  expect(indicator.findAll((n) => n.props?.className?.includes?.('animate-spin')).length)
    .toBeGreaterThan(0);
  expect(text(instance)).not.toContain('%');
});

test('a stage with an honest percentage shows the number', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'loading_model',
    progress_percentage: 0,
  });
  expect(text(instance)).toContain('0%');
  expect(text(instance)).toContain(en.speakers.stages.loading_model);

  emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'loading_model',
    progress_percentage: 100,
  });
  expect(text(instance)).toContain('100%');
});

test('a running pass disables the manual run button, even when it was started automatically', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  expect(diarizeButton(instance).props.disabled).toBeFalse();

  emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'queued',
  });

  expect(diarizeButton(instance).props.disabled).toBeTrue();
  await act(async () => diarizeButton(instance).props.onClick?.());
  expect(diarizeButton(instance)).toBeDefined();
});

test('a manual run shows the stage indicator too and clears it when the command returns', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  let runPromise: Promise<void>;
  await act(async () => {
    runPromise = diarizeButton(instance).props.onClick();
  });
  // The command is in flight: the backend announces its stages over the
  // shared channel while it runs.
  await emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'decoding',
  });
  expect(text(instance)).toContain(en.speakers.stages.decoding);
  expect(diarizeButton(instance).props.disabled).toBeTrue();

  await act(async () => {
    finishDiarize({
      meeting_id: 'meeting-a',
      status: 'ran',
      labeled_segments: 0,
      total_segments: 2,
      speakers_available: true,
      error: null,
    });
  });
  // Drain the rest of handleDiarize (its reload awaits, then the finally
  // that clears the shared pass state) in its own act — a finished manual
  // run must leave no stage behind.
  await act(async () => {
    await runPromise!;
  });
  // The command resolved: no stage may linger as if the pass still ran.
  expect(text(instance)).not.toContain(en.speakers.stages.decoding);
  expect(diarizeButton(instance).props.disabled).toBeFalse();
});

test('the indicator survives speaker rows already on screen', async () => {
  // An automatic pass after import: labels may already exist, and the pass
  // (a recount) still has to be visible — the panel is the source of truth
  // outside the dialogs.
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
  ];
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  emit(bridge, 'diarization-progress', {
    meeting_id: 'meeting-a',
    stage: 'applying_labels',
    progress_percentage: 0,
  });

  expect(text(instance)).toContain('Speaker 1');
  expect(text(instance)).toContain(en.speakers.stages.applying_labels);
});

test('a terminal event ends the pass and the indicator disappears', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  const instance = await renderPanel(store);
  await store.settled();

  emit(bridge, 'diarization-progress', { meeting_id: 'meeting-a', stage: 'inferring' });
  expect(text(instance)).toContain(en.speakers.stages.inferring);

  emit(bridge, 'transcript-updated', {
    meeting_id: 'meeting-a',
    labeled_segments: 2,
    total_segments: 2,
  });

  expect(text(instance)).not.toContain(en.speakers.stages.inferring);
  expect(diarizeButton(instance)?.props.disabled).toBeDefined();
});
