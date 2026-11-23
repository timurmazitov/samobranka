/**
 * Live recording stop flow: diarization after the meeting is saved.
 *
 * The stop flow has already saved the meeting when the pass starts, so the pass
 * must be fire-and-forget: navigation and the success toast cannot wait for it,
 * and a rejected pass must not surface as a save failure.
 *
 * The Tauri event bridge is replaced here because the hook calls `listen`
 * directly at mount; everything else the hook touches is either injected
 * through a service singleton or stubbed at module level. All module mocks are
 * restored in `afterAll` so this file cannot leak into the rest of the run.
 * Timers are fake, so the hook's pacing delays (4 s for late segments, 0.5 s
 * before saving, 2 s before navigation) cost nothing.
 */

import { afterAll, afterEach, beforeEach, expect, jest, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import en from '../../src/i18n/locales/en/translation.json';

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
// module scope. The values mirror `RecordingStateContext`.
const RECORDING_STATUS = {
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  PROCESSING_TRANSCRIPTS: 'processing',
  SAVING: 'saving',
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
/** Recording status string for the error state (not imported: earlier test
 * files mock `RecordingStateContext` and may not export the enum). */
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

// --- native event bridge --------------------------------------------------

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

const { useRecordingStop } = await import('../../src/hooks/useRecordingStop');

// --- harness --------------------------------------------------------------

let stop: (() => Promise<void>) | undefined;
let renderer: ReactTestRenderer | undefined;

function Harness() {
  const { handleRecordingStop } = useRecordingStop(() => {}, () => {});
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
});

/** Mount the hook and deliver the native `recording-stopped` payload. */
async function showPage() {
  jest.useFakeTimers();
  await act(async () => { renderer = create(<Harness />); });
  await act(async () => {
    handlers.get('recording-stopped')?.({
      payload: { folder_path: '/recordings/meeting-1', meeting_name: 'Saved meeting' },
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
  // Wrapped so `await stopAndSave()` does not adopt (and consume) the flow.
  return { run };
}

test('the saved meeting is diarized exactly once and navigation does not wait for the pass', async () => {
  await showPage();

  const { run } = await stopAndSave();
  await settle();

  // One pass, over the meeting the save just returned, before any navigation.
  expect(diarizeMeeting).toHaveBeenCalledTimes(1);
  expect(diarizeMeeting.mock.calls[0][0]).toBe('meeting-1');
  expect(push).not.toHaveBeenCalled();
  expect(releasePass).toBeDefined();

  // The pass is still running and the stop flow has already finished: the
  // success toast and navigation do not depend on it.
  await runUntil(() => push.mock.calls.length > 0);

  await expect(run).resolves.toBeUndefined();
  expect(notify.success).toHaveBeenCalledWith(
    'Recording saved successfully!',
    expect.objectContaining({ description: '1 transcript segments saved.' }),
  );
  expect(push).toHaveBeenCalledWith('/meeting-details?id=meeting-1&source=recording');

  // Completing the long pass afterwards adds no error and no second save.
  await act(async () => { releasePass?.(); await settle(); });
  expect(notify.error).not.toHaveBeenCalled();
  expect(saveMeeting).toHaveBeenCalledTimes(1);
});

test('the configured provider cannot influence the pass: the flow never reads it', async () => {
  // Whatever transcribed the recording — Whisper, Parakeet or audioCpp — the
  // saved meeting is diarized the same way. The stop flow used to look the
  // provider up and gate the pass on it; a transcript-config read reappearing
  // here is the regression this test exists to catch.
  for (const provider of ['localWhisper', 'parakeet', 'audioCpp']) {
    getTranscriptConfig.mockImplementation(async () => ({ provider, model: 'model-a' }));

    await showPage();
    const { run } = await stopAndSave();
    await settle();

    expect(getTranscriptConfig).not.toHaveBeenCalled();
    expect(diarizeMeeting).toHaveBeenCalledTimes(1);
    expect(diarizeMeeting.mock.calls[0][0]).toBe('meeting-1');
    expect(run).toBeDefined();

    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    diarizeMeeting.mockClear();
    saveMeeting.mockClear();
    getTranscriptConfig.mockClear();
    getTranscriptionStatus.mockClear();
    for (const fn of Object.values(notify)) fn.mockClear();
  }
});

test('only a failed pass toasts; configuration statuses stay silent', async () => {
  const cases: Array<[SettledStatus, boolean]> = [
    ['ran', false],
    ['no_model', false],
    ['no_runtime', false],
    ['deferred', false],
    ['failed', true],
  ];

  for (const [status, speaks] of cases) {
    await showPage();
    passOutcome = status;

    await stopAndSave();
    await runUntil(() => diarizeMeeting.mock.calls.length > 0);
    await settle();

    expect(notify.error).toHaveBeenCalledTimes(speaks ? 1 : 0);
    if (speaks) {
      expect(notify.error).toHaveBeenCalledWith('Diarization failed', {
        description: en.speakers.failures.failed,
      });
    }

    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    jest.useRealTimers();
    for (const fn of Object.values(notify)) fn.mockClear();
    saveMeeting.mockClear();
    diarizeMeeting.mockClear();
    recordingState.setStatus.mockClear();
    push.mockClear();
  }
});

test('a rejected pass leaves the saved meeting saved and the stop flow successful', async () => {
  await showPage();
  passOutcome = 'reject';

  const { run } = await stopAndSave();
  await runUntil(() => push.mock.calls.length > 0);
  await settle();

  // Saving succeeded, the flow never entered its error path, and the pass's
  // rejection produced no toast and no failed status.
  expect(markMeetingAsSaved).toHaveBeenCalledTimes(1);
  expect(notify.success).toHaveBeenCalledWith(
    'Recording saved successfully!',
    expect.anything(),
  );
  expect(notify.error).not.toHaveBeenCalled();
  expect(recordingState.setStatus).not.toHaveBeenCalledWith(ERROR_STATUS);
  await expect(run).resolves.toBeUndefined();
  expect(push).toHaveBeenCalledWith('/meeting-details?id=meeting-1&source=recording');
});
