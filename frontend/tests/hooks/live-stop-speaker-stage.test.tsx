/**
 * Live recording stop flow: the «Определяем спикеров…» stage (ticket 06).
 *
 * After the save, the stop sequence holds at the speaker stage while the
 * shared pass state says a diarization pass is really working, and completes
 * only after the pass's terminal. A pass that never runs (no model, no
 * runtime, deferred) answers through the command's own result, so the stage
 * is skipped silently and the stop finishes as before. Leaving the recording
 * page during the pass must not kill the pass or the store's listeners: the
 * indicator's source of truth is the shared store, not the stop dialog.
 *
 * Same harness as `live-recording-diarization.test.tsx` (fake timers, module
 * mocks restored in `afterAll`, injected diarization client), plus a fresh
 * `DiarizationPassStore` per test driven by fake `diarization-progress`
 * events — the stop hook takes the store as its third argument, so no
 * singleton state leaks between tests or files.
 */

import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The hook reaches for `window` (the Rust bridge) and `sessionStorage` (the
// folder path handed over by the native `recording-stopped` event). Bun has no
// DOM, so both are stood up here instead of pulling in a browser environment.
class MemoryStorage {
  private readonly items = new Map<string, string>();
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

const globals = globalThis as unknown as { window?: unknown; sessionStorage: MemoryStorage };
beforeEach(() => {
  globals.window = {};
  globals.sessionStorage = new MemoryStorage();
});

const MOCKED = [
  '@tauri-apps/api/event',
  'next/navigation',
  'sonner',
  '../../src/services/storageService',
  '../../src/services/transcriptService',
  '../../src/services/configService',
  '../../src/lib/summary-language-preferences',
  '../../src/lib/diarizationClient',
  '../../src/contexts/TranscriptContext',
  '../../src/components/Sidebar/SidebarProvider',
] as const;

// Captured before the stub below so `afterAll` can put the genuine module back
// instead of re-installing the stub into every file bun loads afterwards.
const originalRecordingContext = {
  ...(await import('../../src/contexts/RecordingStateContext')),
} as Record<string, unknown>;

const recordingState = {
  status: 'recording',
  setStatus: mock((_status: unknown, _message?: string) => {}),
  isStopping: false,
  isProcessing: false,
  isSaving: false,
};
// Defined here rather than imported: earlier suites replace this module with a
// stub that lacks the enum, and `useRecordingStop` imports `RecordingStatus` at
// module scope. The values mirror `RecordingStateContext`, including the new
// speaker stage.
const RECORDING_STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  PROCESSING_TRANSCRIPTS: 'processing',
  SAVING: 'saving',
  DIARIZING: 'diarizing',
  COMPLETED: 'completed',
  ERROR: 'error',
};
const recordingContextMock = () => ({
  RecordingStatus: RECORDING_STATUS,
  useRecordingState: () => recordingState,
});
mock.module('../../src/contexts/RecordingStateContext', recordingContextMock);
mock.module('@/contexts/RecordingStateContext', recordingContextMock);

const originals = new Map<string, Record<string, unknown>>();
for (const path of MOCKED) originals.set(path, { ...(await import(path)) });

afterAll(() => {
  for (const [path, exports] of originals) mock.module(path, () => exports);
  mock.module('../../src/contexts/RecordingStateContext', () => originalRecordingContext);
});

const original = (path: (typeof MOCKED)[number]) => originals.get(path)!;
/** Recording status strings for assertions (not imported: earlier test files
 * mock `RecordingStateContext` and may not export the enum). */
const SAVING_STATUS = 'saving';
const DIARIZING_STATUS = 'diarizing';
const COMPLETED_STATUS = 'completed';
const ERROR_STATUS = 'error';

// --- the diarization pass under test ---------------------------------------

type SettledStatus = 'ran' | 'no_model' | 'no_runtime' | 'deferred' | 'failed';
let passOutcome: SettledStatus | 'reject' | 'pending' = 'pending';
let releasePass: (() => void) | undefined;
const diarizeMeeting = mock(async (_meetingId: string) => {
  if (passOutcome === 'pending') {
    await new Promise<void>((resolve) => { releasePass = resolve; });
    return { meeting_id: 'meeting-1', status: 'ran', labeled_segments: 1, total_segments: 1, speakers_available: true };
  }
  if (passOutcome === 'reject') throw new Error('native pass rejected');
  return {
    meeting_id: 'meeting-1',
    status: passOutcome,
    labeled_segments: passOutcome === 'ran' ? 1 : 0,
    total_segments: 1,
    speakers_available: passOutcome === 'ran',
    error: passOutcome === 'failed' ? 'engine exploded' : null,
  };
});
mock.module('../../src/lib/diarizationClient', () => ({
  diarizationClient: { diarizeMeeting },
}));

// --- the save + navigation surfaces ---------------------------------------

const saveMeeting = mock(async (_title: string, _transcripts: unknown[], _folderPath: string | null) => ({
  meeting_id: 'meeting-1',
}));
const getMeeting = mock(async (meetingId: string) => ({ id: meetingId, title: 'Saved meeting' }));
const getTranscriptionStatus = mock(async () => ({
  is_processing: false,
  chunks_in_queue: 0,
  last_activity_ms: 99999,
}));
mock.module('../../src/services/storageService', () => ({
  storageService: { saveMeeting, getMeeting },
}));
mock.module('../../src/services/transcriptService', () => ({
  transcriptService: { getTranscriptionStatus },
}));
const getTranscriptConfig = mock(async () => ({ provider: 'audioCpp', model: 'gigaam' }));
mock.module('../../src/services/configService', () => ({
  ...original('../../src/services/configService'),
  configService: { getTranscriptConfig },
}));
mock.module('../../src/lib/summary-language-preferences', () => ({
  applyPinnedSummaryLanguageToMeeting: async () => true,
  detectAndCacheSummaryLanguage: async () => ({ language: 'en' }),
}));

// --- native event bridge (the hook's own `listen` calls) -------------------

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const listen = mock(async (name: string, handler: (event: { payload: unknown }) => void) => {
  handlers.set(name, handler);
  return () => { handlers.delete(name); };
});
mock.module('@tauri-apps/api/event', () => ({ listen }));

// --- UI surfaces ----------------------------------------------------------

const notify = {
  info: mock((_message: string, _options?: unknown) => {}),
  error: mock((_message: string, _options?: unknown) => {}),
  success: mock((_message: string, _options?: unknown) => {}),
  warning: mock((_message: string, _options?: unknown) => {}),
};
mock.module('sonner', () => ({ toast: notify }));

const push = mock((_url: string) => {});
mock.module('next/navigation', () => ({ useRouter: () => ({ push }) }));

const markMeetingAsSaved = mock(async () => {});
mock.module('../../src/contexts/TranscriptContext', () => ({
  useTranscripts: () => ({
    transcriptsRef: { current: [{ id: 't1', text: 'hello', timestamp: '00:00' }] },
    flushBuffer: () => {},
    clearTranscripts: () => {},
    meetingTitle: 'Call',
    markMeetingAsSaved,
  }),
}));

const refetchMeetings = mock(async () => {});
const setCurrentMeeting = mock((_meeting: unknown) => {});
mock.module('../../src/components/Sidebar/SidebarProvider', () => ({
  // Keep the real provider export so a suite that loads after this file and
  // renders inside it still mounts; only the hook is stubbed for the stop flow.
  ...(original('../../src/components/Sidebar/SidebarProvider') as object),
  useSidebar: () => ({
    refetchMeetings,
    setCurrentMeeting,
    setMeetings: () => {},
    meetings: [],
    setIsMeetingActive: () => {},
  }),
}));

// --- the shared pass store, driven by fake events --------------------------

const { DiarizationPassStore } = await import('../../src/lib/diarization');
type PassStore = InstanceType<typeof DiarizationPassStore>;

/** A registered store listener, callable from the test with any payload. */
type StoreHandler = (event: { payload: unknown }) => void;

interface PassBridge {
  store: PassStore;
  /** Registered event handlers, keyed by event name. */
  registered: Map<string, StoreHandler>;
  /** Event names whose listener was torn down. */
  unlistened: string[];
}

function makePassBridge(): PassBridge {
  const registered = new Map<string, StoreHandler>();
  const unlistened: string[] = [];
  const store = new DiarizationPassStore(async (name, handler) => {
    registered.set(name, handler as unknown as StoreHandler);
    return () => {
      registered.delete(name);
      unlistened.push(name);
    };
  });
  return { store, registered, unlistened };
}

// --- harness --------------------------------------------------------------

const { useRecordingStop } = await import('../../src/hooks/useRecordingStop');

let stop: (() => Promise<void>) | undefined;
let renderer: ReactTestRenderer | undefined;

function Harness({ passStore }: { passStore: PassStore }) {
  const { handleRecordingStop } = useRecordingStop(() => {}, () => {}, passStore);
  stop = () => handleRecordingStop(true);
  return <span>recording page</span>;
}

/** Flush queued microtasks so the hook's awaits make progress. */
async function settle() {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

/**
 * Advance fake time in small steps, flushing microtasks between them, so a
 * delay scheduled *after* an awaited step still gets fired. Stops as soon as
 * `done` holds.
 */
async function runUntil(done: () => boolean, maxMs = 10000, step = 25) {
  for (let elapsed = 0; elapsed <= maxMs && !done(); elapsed += step) {
    await act(async () => {
      jest.advanceTimersByTime(step);
      await settle();
    });
  }
}

let bridge: PassBridge = makePassBridge();

afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
  jest.useRealTimers();
  handlers.clear();
  diarizeMeeting.mockClear();
  saveMeeting.mockClear();
  getMeeting.mockClear();
  getTranscriptionStatus.mockClear();
  markMeetingAsSaved.mockClear();
  refetchMeetings.mockClear();
  setCurrentMeeting.mockClear();
  push.mockClear();
  listen.mockClear();
  recordingState.setStatus.mockClear();
  for (const fn of Object.values(notify)) fn.mockClear();
  passOutcome = 'pending';
  releasePass = undefined;
  bridge.store.dispose();
});

/** Mount the hook and deliver the native `recording-stopped` payload. */
async function showPage() {
  jest.useFakeTimers();
  bridge = makePassBridge();
  await act(async () => { renderer = create(<Harness passStore={bridge.store} />); });
  await act(async () => {
    handlers.get('recording-stopped')?.({
      payload: { message: 'stopped', folder_path: '/recordings/meeting-1', meeting_name: 'Saved meeting' },
    });
    await settle();
  });
  expect(handlers.has('recording-stopped')).toBe(true);
}

/** Stop the recording and run the flow up to the save + pass dispatch. */
async function stopAndSave() {
  const run = stop!();
  await runUntil(() => saveMeeting.mock.calls.length > 0);
  expect(saveMeeting).toHaveBeenCalledTimes(1);
  // Let the pass be dispatched and the store's listeners attach, so a fake
  // event delivered next cannot race an unfinished registration.
  await act(async () => {
    await settle();
    await bridge.store.settled();
  });
  // Wrapped so `await stopAndSave()` does not adopt (and consume) the flow.
  return { run };
}

/** Deliver a `diarization-progress` event for this meeting through the store. */
async function emitProgress(payload: Record<string, unknown>) {
  const handler = bridge.registered.get('diarization-progress');
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload: { meeting_id: 'meeting-1', ...payload } });
    await settle();
  });
}

/** Deliver a terminal event for this meeting through the store. */
async function emitTerminal(event: string, payload: Record<string, unknown>) {
  const handler = bridge.registered.get(event);
  expect(handler).toBeDefined();
  await act(async () => {
    handler!({ payload: { meeting_id: 'meeting-1', ...payload } });
    await settle();
  });
}

const statusCalls = () => recordingState.setStatus.mock.calls.map((call) => call[0]);

test('the stop flow shows the speaker stage while the pass runs and completes after its terminal', async () => {
  await showPage();
  const { run } = await stopAndSave();

  // One pass over the saved meeting, and the stop has NOT completed yet:
  // the flow is holding after the save, before any speaker stage.
  expect(diarizeMeeting).toHaveBeenCalledTimes(1);
  expect(diarizeMeeting.mock.calls[0][0]).toBe('meeting-1');
  expect(statusCalls()).toContain(SAVING_STATUS);
  expect(statusCalls()).not.toContain(DIARIZING_STATUS);
  expect(statusCalls()).not.toContain(COMPLETED_STATUS);
  expect(push).not.toHaveBeenCalled();

  // The pass announces its first stage: the stop sequence enters the
  // speaker stage and still has not completed.
  await emitProgress({ stage: 'loading_model', progress_percentage: 10 });
  expect(statusCalls()).toContain(DIARIZING_STATUS);
  expect(statusCalls()).not.toContain(COMPLETED_STATUS);
  expect(bridge.store.getState('meeting-1')?.phase).toBe('running');

  await emitProgress({ stage: 'inferring' });
  expect(statusCalls()).not.toContain(COMPLETED_STATUS);

  // The pass ends: the terminal lands, then the command returns. Only now
  // does the stop complete.
  await emitTerminal('transcript-updated', { labeled_segments: 1, total_segments: 1 });
  await act(async () => { releasePass?.(); await settle(); });

  expect(statusCalls()).toContain(COMPLETED_STATUS);
  const calls = statusCalls();
  expect(calls.indexOf(SAVING_STATUS)).toBeLessThan(calls.indexOf(DIARIZING_STATUS));
  expect(calls.indexOf(DIARIZING_STATUS)).toBeLessThan(calls.indexOf(COMPLETED_STATUS));
  await runUntil(() => push.mock.calls.length > 0);
  expect(push).toHaveBeenCalledWith('/meeting-details?id=meeting-1&source=recording');
  await expect(run).resolves.toBeUndefined();
});

test('a deferred pass skips the stage silently and the stop completes without delay', async () => {
  await showPage();
  passOutcome = 'deferred';

  const { run } = await stopAndSave();
  // No progress event ever arrives; the command answers immediately with the
  // deferral, so the stop completes like before: no stage, no waiting.
  await runUntil(() => push.mock.calls.length > 0, 2500);

  expect(statusCalls()).not.toContain(DIARIZING_STATUS);
  expect(statusCalls()).toContain(COMPLETED_STATUS);
  expect(notify.info).not.toHaveBeenCalled();
  expect(notify.error).not.toHaveBeenCalled();
  await expect(run).resolves.toBeUndefined();
});

test('no model and no runtime skip the stage silently: completed without waiting', async () => {
  for (const status of ['no_model', 'no_runtime'] as const) {
    await showPage();
    passOutcome = status;

    const { run } = await stopAndSave();
    // The whole remainder of the stop must finish inside the normal 2 s
    // navigation delay — far below the first-signal hang guard, so no timer
    // was needed to conclude the pass is not running.
    await runUntil(() => push.mock.calls.length > 0, 2500);

    expect(statusCalls()).not.toContain(DIARIZING_STATUS);
    expect(statusCalls()).toContain(COMPLETED_STATUS);
    expect(notify.error).not.toHaveBeenCalled();
    expect(recordingState.setStatus).not.toHaveBeenCalledWith(ERROR_STATUS);
    await expect(run).resolves.toBeUndefined();

    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    bridge.store.dispose();
    for (const fn of Object.values(notify)) fn.mockClear();
    saveMeeting.mockClear();
    diarizeMeeting.mockClear();
    recordingState.setStatus.mockClear();
    push.mockClear();
  }
});

test('a pass that never announces itself does not hang the stop: the first-signal guard skips the stage', async () => {
  await showPage();
  // The command never resolves and no stage is ever announced — the shape of
  // a native side that hangs before deciding. The stop must still complete.
  const { run } = await stopAndSave();

  await runUntil(() => push.mock.calls.length > 0, 15000);
  expect(statusCalls()).not.toContain(DIARIZING_STATUS);
  expect(statusCalls()).toContain(COMPLETED_STATUS);
  expect(push).toHaveBeenCalledWith('/meeting-details?id=meeting-1&source=recording');
  await expect(run).resolves.toBeUndefined();
});

test('a pass that announces itself then dies without a terminal still completes the stop', async () => {
  await showPage();
  const { run } = await stopAndSave();

  await emitProgress({ stage: 'inferring' });
  expect(statusCalls()).toContain(DIARIZING_STATUS);

  // Neither the command returns nor a terminal lands: the stalled-pass guard
  // gives up on the pass so the stop finishes.
  await runUntil(() => statusCalls().includes(COMPLETED_STATUS), 620_000, 5000);
  expect(statusCalls()).toContain(COMPLETED_STATUS);
  await runUntil(() => push.mock.calls.length > 0);
  await expect(run).resolves.toBeUndefined();
});

test('leaving the recording page during the pass keeps the pass and the store listeners alive', async () => {
  await showPage();
  const { run } = await stopAndSave();

  await emitProgress({ stage: 'decoding' });
  expect(statusCalls()).toContain(DIARIZING_STATUS);

  // The user navigates away: the stop dialog unmounts. The pass state and
  // the store's event listeners must survive — the speakers panel reads the
  // same store, so the indicator keeps living there.
  await act(async () => { renderer!.unmount(); });
  renderer = undefined;

  expect(bridge.store.getState('meeting-1')?.phase).toBe('running');
  expect(bridge.store.getState('meeting-1')?.stage).toBe('decoding');
  expect(bridge.store.isListening()).toBe(true);
  expect(bridge.registered.has('diarization-progress')).toBe(true);
  expect(bridge.unlistened).not.toContain('diarization-progress');

  // A stage announced after the navigation still moves the shared state.
  await emitProgress({ stage: 'inferring' });
  expect(bridge.store.getState('meeting-1')?.stage).toBe('inferring');

  // The terminal clears it, and the unmounted flow still finishes.
  await emitTerminal('transcript-updated', { labeled_segments: 1, total_segments: 1 });
  await act(async () => { releasePass?.(); await settle(); });
  expect(bridge.store.getState('meeting-1')).toBeNull();
  expect(statusCalls()).toContain(COMPLETED_STATUS);
  await expect(run).resolves.toBeUndefined();
});
