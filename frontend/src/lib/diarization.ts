/**
 * Post-transcription diarization of a saved meeting.
 *
 * The recording pipeline saves the meeting as soon as the last transcript
 * segment lands; diarization is a separate pass over the saved recording
 * (GLOSSARY: «диаризация» — postprocessing after transcription). The pass is
 * independent of the transcription provider: native code decides whether it
 * can run (installed Nemotron model, available audio.cpp runtime, no active
 * recording) and reports the outcome as a status. This module holds the seam
 * and the status→UI rules; it never decides availability itself.
 *
 * Kept free of Tauri imports at module scope so plain unit tests can inject a
 * fake: production uses `TauriDiarizationClient` via `diarizationClient`.
 * Tauri's `invoke` is imported dynamically inside the production client so a
 * test that never touches it does not need the native bridge.
 */

import i18n from '@/i18n';

import type { AudioCppModelInfo } from './audiocpp';

/**
 * Why a diarization pass did or did not happen, as native code reports it.
 *
 * `ran` with zero labeled segments is a successful pass over a recording with
 * no distinguishable voices, not a failure.
 */
export type DiarizationStatus = 'ran' | 'no_model' | 'no_runtime' | 'deferred' | 'failed';

/** Result of a diarization pass, as returned by `audiocpp_diarize_meeting`. */
export interface DiarizationResult {
  meeting_id: string;
  /** Why the pass did or did not run. */
  status: DiarizationStatus;
  /** Number of transcript segments that received a speaker label. */
  labeled_segments: number;
  total_segments: number;
  /** Historical availability flag, derived natively from `status === 'ran'`. */
  speakers_available: boolean;
  /** Diagnostic detail for `failed`; never user-facing prose. */
  error?: string | null;
}

/** The native command the diarization seam calls. */
export const AUDIOCPP_DIARIZE_COMMAND = 'audiocpp_diarize_meeting';

/** The seam between the UI and the native diarization command. */
export interface DiarizationClient {
  /** Diarize a saved meeting, resolving with the native result. */
  diarizeMeeting(meetingId: string): Promise<DiarizationResult>;
}

/** Native implementation over the Tauri command. */
export class TauriDiarizationClient implements DiarizationClient {
  private readonly invokeImpl?: (
    command: string,
    args: Record<string, unknown>,
  ) => Promise<DiarizationResult>;

  /**
   * `invokeImpl` is the test seam: production leaves it unset and the Tauri
   * bridge is imported lazily, so unit tests can assert the exact command
   * without module-level Tauri mocks leaking across test files.
   */
  constructor(
    invokeImpl?: (command: string, args: Record<string, unknown>) => Promise<DiarizationResult>,
  ) {
    this.invokeImpl = invokeImpl;
  }

  async diarizeMeeting(meetingId: string): Promise<DiarizationResult> {
    const invoke =
      this.invokeImpl ?? (await import('@tauri-apps/api/core')).invoke;
    return invoke(AUDIOCPP_DIARIZE_COMMAND, { meetingId });
  }
}

/**
 * Mirrored native message texts.
 *
 * `frontend/src-tauri/src/audio/transcription/diarization_service.rs` is the
 * source of truth; the frontend duplicates the strings it needs for direct
 * answers to an explicit run. `tests/lib/live-diarization.test.ts` compares
 * them verbatim, so the two cannot drift apart silently.
 */

/** Native `DIARIZATION_UNAVAILABLE_MESSAGE`: no diarization model installed. */
export const DIARIZATION_NO_MODEL_MESSAGE =
  'Speaker labels were skipped. Download the Nemotron-3-Diarization model in Settings to see who said what.';

/** Native `DIARIZATION_RUNTIME_UNAVAILABLE_MESSAGE`: model present, library missing. */
export const DIARIZATION_NO_RUNTIME_MESSAGE =
  'Speaker labels were skipped. The audio.cpp engine is unavailable on this system.';

/** Native `DIARIZATION_FAILED_MESSAGE`: the pass was attempted and broke. */
export const DIARIZATION_FAILED_MESSAGE =
  'Speaker labels were skipped because diarization failed.';

/**
 * No native counterpart: a deferred pass is silent in automatic paths, so
 * native code has no message for it. The panel explains it when the user asks
 * for a run during a recording.
 */
export const DIARIZATION_DEFERRED_MESSAGE =
  'Speaker labels were postponed because a recording is in progress. Run diarization again once the recording stops.';

/**
 * No native counterpart: `ran` with zero labels is a successful pass, so native
 * code has no refusal text. The panel still explains why the list stayed empty
 * after the user pressed the button.
 */
export const DIARIZATION_NO_SPEAKERS_FOUND_MESSAGE =
  'Diarization finished but found no distinct speakers in this recording.';

/** Hint shown in the speakers panel when the meeting has no labels yet. */
export const DIARIZATION_UNAVAILABLE_HINT =
  'Download the Nemotron-3-Diarization model in Settings to see who said what.';

/** Hint shown when a recount of the labels removed every speaker name. */
export const SPEAKER_NAMES_RESET_HINT =
  'Speaker names were reset because the voices were recomputed.';

/** The native event that announces a full reset of the meeting's names. */
export const SPEAKER_NAMES_RESET_EVENT = 'speaker-names-reset';

/** Payload of the `speaker-names-reset` event. */
export interface SpeakerNamesResetPayload {
  /**
   * The meeting whose names changed. Every save path recounts on a saved
   * meeting, so the id is always present; optional for older payloads.
   */
  meeting_id?: string;
  message?: string;
}

/**
 * The native event announcing that a saved meeting's transcript gained speaker
 * labels. The meeting page subscribes to it instead of the old window event, so
 * a background pass can refresh an open meeting on its own.
 */
export const TRANSCRIPT_UPDATED_EVENT = 'transcript-updated';

/**
 * The native event announcing that a pass ran and did not produce labels
 * (only `failed` fires it today). Its channel and payload form are not the
 * pass state's business; the store only ends a pass when it arrives.
 */
export const DIARIZATION_UNAVAILABLE_EVENT = 'diarization-unavailable';

/** Payload of the `transcript-updated` event. */
export interface TranscriptUpdatedPayload {
  /** The meeting whose labels changed; absent payloads match no page. */
  meeting_id?: string;
  labeled_segments?: number;
  total_segments?: number;
}

/**
 * The native channel announcing the live stage of a running diarization
 * pass, so every surface can tell "the pass is working" from "it never
 * started" and "it died". The terminal events keep their own channels; this
 * one only precedes them.
 */
export const DIARIZATION_PROGRESS_EVENT = 'diarization-progress';

/**
 * The pass stages, in pass order, mirroring the native `DiarizationStage`
 * enum snake_case exactly (pinned by `tests/lib/live-diarization.test.ts`).
 */
export const DIARIZATION_STAGES = [
  'queued',
  'loading_model',
  'decoding',
  'inferring',
  'applying_labels',
] as const;

export type DiarizationStage = (typeof DIARIZATION_STAGES)[number];

/** Payload of the `diarization-progress` event. */
export interface DiarizationProgressPayload {
  /** The meeting the pass runs for; events without an id cannot be attributed. */
  meeting_id?: string;
  stage?: DiarizationStage;
  /**
   * Present only where the percentage is honest (model load, label write);
   * absent on indeterminate stages like `inferring`, so "no number" stays
   * distinguishable from "zero percent".
   */
  progress_percentage?: number | null;
  /** Stage sentence owned by native code; the UI may prefer its own i18n text. */
  message?: string;
}

/** The shared pass state one meeting can be in, as the store keeps it. */
export interface DiarizationPassState {
  meetingId: string;
  stage: DiarizationStage;
  /** `null` means indeterminate: the stage owes no honest number. */
  progressPercentage: number | null;
  message: string | null;
}

/** Whether a value is one of the native stages. Unknown stages are future
 * payloads, not work to attribute, and the pass state ignores them. */
function isDiarizationStage(value: unknown): value is DiarizationStage {
  return typeof value === 'string' && (DIARIZATION_STAGES as readonly string[]).includes(value);
}

/**
 * The panel/dialog sentence for a pass stage, in the current language.
 *
 * The keys are written literally so the i18n usage guard sees them; a stage
 * the UI has never seen falls back to the native message the event carried.
 */
export function diarizationStageMessage(stage: DiarizationStage): string {
  switch (stage) {
    case 'queued':
      return i18n.t('speakers.stages.queued');
    case 'loading_model':
      return i18n.t('speakers.stages.loading_model');
    case 'decoding':
      return i18n.t('speakers.stages.decoding');
    case 'inferring':
      return i18n.t('speakers.stages.inferring');
    case 'applying_labels':
      return i18n.t('speakers.stages.applying_labels');
  }
}

/**
 * Folds one `diarization-progress` payload into the meeting's pass state.
 *
 * Pure and total: a payload without a meeting id cannot be attributed, and
 * an unknown stage cannot start or move a pass — both return `current`
 * unchanged. A percentage outside `0..100` is not trusted and reads as
 * indeterminate, never as a number on screen.
 */
export function applyDiarizationProgress(
  current: DiarizationPassState | null,
  payload: DiarizationProgressPayload,
): DiarizationPassState | null {
  if (!payload.meeting_id) return current;
  if (!isDiarizationStage(payload.stage)) return current;
  const raw = payload.progress_percentage;
  const progressPercentage =
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 100 ? raw : null;
  return {
    meetingId: payload.meeting_id,
    stage: payload.stage,
    progressPercentage,
    message: typeof payload.message === 'string' ? payload.message : null,
  };
}

/**
 * What the pass store needs from the Tauri event bridge. Injectable for the
 * same reason `TauriDiarizationClient` takes `invokeImpl`: tests drive the
 * single listener with fake events instead of a module-level Tauri mock.
 */
export type DiarizationPassListen = (
  event: string,
  handler: (event: { payload: never }) => void,
) => Promise<() => void>;

/** Production bridge: Tauri's `listen`, imported lazily so merely importing
 * this module never touches the native dependency. */
const tauriPassListen: DiarizationPassListen = async (event, handler) => {
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, handler);
};

/** The terminal events that end a pass; each keeps its own channel and
 * payload form — the store only reads `meeting_id` to know which pass. */
const PASS_TERMINAL_EVENTS = [
  TRANSCRIPT_UPDATED_EVENT,
  DIARIZATION_UNAVAILABLE_EVENT,
  SPEAKER_NAMES_RESET_EVENT,
] as const;

/**
 * The one per-meeting diarization pass state every surface reads: the
 * speakers panel, the import and retranscription dialogs, and the live-stop
 * status sequence all subscribe here, so a detached pass keeps its
 * indicator alive across dialogs closing and navigation.
 *
 * A single listener set for the pass channel plus the three terminals backs
 * the whole store; it is attached when the first subscriber arrives and
 * dropped when the last one leaves, mirroring the injectable-bridge pattern
 * of the diarization hooks. A bridge that is not ready yet (unit tests, a
 * plain browser preview, a page-load race) only logs: the store stays
 * empty, and the next subscription retries.
 */
export class DiarizationPassStore {
  private readonly listenImpl: DiarizationPassListen;
  private readonly states = new Map<string, DiarizationPassState>();
  /**
   * Terminals already seen per meeting, kept after the pass state is dropped.
   * A surface that started watching mid-pass (an import dialog learning its
   * meeting id only when the transcript is saved) cannot tell "the terminal
   * already fired" from "no pass was ever scheduled" without this record;
   * without it its bar would wait for a completion that already happened.
   * Bounded oldest-first: it only has to cover the short window between a
   * pass starting and a surface subscribing to it, and imports/retranscriptions
   * are serialized, so a few dozen recent meetings is ample.
   */
  private readonly terminals = new Set<string>();
  private static readonly TERMINALS_LIMIT = 64;
  private readonly subscribers = new Set<() => void>();
  private teardown: (() => void) | null = null;
  private listening = false;
  /** Bumped by every start/stop; an in-flight registration that loses the
   * race against a stop tears itself down instead of orphaning listeners. */
  private generation = 0;
  private settledPromise: Promise<void> = Promise.resolve();

  constructor(listenImpl: DiarizationPassListen = tauriPassListen) {
    this.listenImpl = listenImpl;
  }

  /** The state of one meeting, or `null` when no pass is known for it. */
  getState(meetingId: string): DiarizationPassState | null {
    return this.states.get(meetingId) ?? null;
  }

  /** Whether the bridge listeners are attached right now. */
  isListening(): boolean {
    return this.listening;
  }

  /** Resolves when the current subscribe/unsubscribe bridge work has settled. */
  async settled(): Promise<void> {
    await this.settledPromise;
  }

  /**
   * Registers a change listener; returns the unsubscribe. Every event —
   * progress or terminal — notifies every listener; callers re-read their
   * own meeting with `getState`.
   */
  subscribe(onChange?: () => void): () => void {
    const listener = onChange ?? (() => {});
    this.subscribers.add(listener);
    if (this.subscribers.size === 1) this.start();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.subscribers.delete(listener);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  /** Whether a terminal event has already been seen for the meeting, even
   * after the pass state was dropped. A surface that starts watching a pass
   * mid-way (the import dialog learns the meeting id only when the transcript
   * is saved) cannot otherwise tell "the terminal already fired" from "no
   * pass was ever scheduled", and would wait for a completion that already
   * happened. */
  hasSeenTerminal(meetingId: string): boolean {
    return this.terminals.has(meetingId);
  }

  /** Drops one meeting's pass state without waiting for a terminal event. */
  clear(meetingId: string): void {
    const known = this.states.delete(meetingId) || this.terminals.delete(meetingId);
    if (known) this.notify();
  }

  /** Releases the bridge and every subscriber (tests, app shutdown). */
  dispose(): void {
    this.subscribers.clear();
    this.terminals.clear();
    this.stop();
  }

  /**
   * Attaches the four listeners once, guarding against a stop that lands
   * while they are still registering (React StrictMode mounts, unmounts and
   * remounts): a registration that loses the generation race tears itself
   * down instead of orphaning listeners that would notify a dead subscriber.
   */
  private start(): void {
    const generation = (this.generation += 1);
    this.listening = false;
    const names: string[] = [DIARIZATION_PROGRESS_EVENT, ...PASS_TERMINAL_EVENTS];
    this.settledPromise = (async () => {
      const unlisteners: Array<() => void> = [];
      const abandon = () => {
        for (const unlisten of unlisteners) unlisten();
        this.listening = false;
      };
      for (const name of names) {
        if (generation !== this.generation) {
          // Stopped before this beat; drop whatever partial registration
          // exists so nothing outlives the last subscriber.
          abandon();
          return;
        }
        try {
          unlisteners.push(
            await this.listenImpl(name, (event) => this.handle(name, event.payload)),
          );
        } catch (error) {
          // The bridge is not ready: keep any partial registration torn down
          // and stay silent; the next 0→1 subscription retries.
          abandon();
          console.warn('Failed to listen for diarization progress:', error);
          return;
        }
      }
      if (generation !== this.generation) {
        abandon();
        return;
      }
      this.teardown = () => {
        for (const unlisten of unlisteners) unlisten();
        this.teardown = null;
        this.listening = false;
      };
      this.listening = true;
    })();
  }

  private stop(): void {
    // Invalidate any in-flight registration first, then drop the settled one.
    this.generation += 1;
    this.teardown?.();
    this.listening = false;
  }

  private notify(): void {
    for (const listener of [...this.subscribers]) listener();
  }

  private handle(name: string, payload: unknown): void {
    const record = (payload ?? {}) as Record<string, unknown>;
    const meetingId = typeof record.meeting_id === 'string' ? record.meeting_id : undefined;
    if (name === DIARIZATION_PROGRESS_EVENT) {
      // The reducer ignores an id-less or unknown-stage payload entirely;
      // `current` comes from the store so a pass only moves forward.
      const current = meetingId ? this.states.get(meetingId) ?? null : null;
      const next = applyDiarizationProgress(current, record as DiarizationProgressPayload);
      if (!next || !meetingId || next === current) return;
      // A running pass supersedes any terminal recorded earlier (a retranscription
      // of a meeting that was already diarized must not look finished).
      this.terminals.delete(meetingId);
      this.states.set(meetingId, next);
      this.notify();
      return;
    }
    // Terminal: the pass is over, whatever the terminal says next is its own
    // business. An unattributable terminal names no pass and hangs none — the
    // manual run's completion clears its own state regardless. The meeting is
    // recorded as finished even when no pass state existed for it, so a late
    // watcher (an import dialog learning its id at the save) learns the pass
    // already ended; every subscriber is notified either way.
    if (!meetingId) return;
    // Bound the record oldest-first (Sets keep insertion order): it only has
    // to outlive the small gap between a pass ending and a late watcher
    // subscribing, never the whole session.
    this.terminals.delete(meetingId);
    this.terminals.add(meetingId);
    while (this.terminals.size > DiarizationPassStore.TERMINALS_LIMIT) {
      const oldest = this.terminals.values().next().value;
      if (oldest === undefined) break;
      this.terminals.delete(oldest);
    }
    this.states.delete(meetingId);
    this.notify();
  }
}

/**
 * Whether an automatic pass should interrupt the user with a toast.
 *
 * Only `failed` does: the three configuration statuses were not requested by
 * the user, so `no_model`, `no_runtime` and `deferred` stay silent.
 */
export function shouldToastDiarizationStatus(status: DiarizationStatus): boolean {
  return status === 'failed';
}

/** What a diarization failure toast needs from the toast library. */
export interface DiarizationToast {
  error(message: string, options?: { description?: string }): void;
}

/**
 * The one place that words a failed diarization pass.
 *
 * The live stop flow, the import dialog and the retranscription dialog all
 * announce the same event, and a second wording would make the same failure
 * read differently depending on which screen noticed it. The description stays
 * the native text when the event carries one, so native code remains the source
 * of truth for the explanation.
 */
export function showDiarizationFailure(
  toast: DiarizationToast,
  message?: string,
): void {
  toast.error(i18n.t('toasts.diarization.failed'), {
    description: message ?? DIARIZATION_FAILED_MESSAGE,
  });
}

/**
 * The automatic pass after a live recording, as one testable step.
 *
 * Returns a promise instead of being fire-and-forget itself so a test can
 * await the outcome; the stop flow drops it with `void`, which is what keeps
 * saving and navigation off the pass's critical path. Never rejects: a native
 * failure leaves the saved meeting unlabeled and stays silent, because the
 * meeting and its transcript are already safe.
 */
export async function startLiveDiarization(
  client: DiarizationClient,
  meetingId: string,
  toast: DiarizationToast,
): Promise<void> {
  let result: DiarizationResult;
  try {
    result = await client.diarizeMeeting(meetingId);
  } catch {
    // The native command itself failed: the meeting stays saved without
    // labels, and there is no status to explain.
    return;
  }
  if (!shouldToastDiarizationStatus(result.status)) return;
  showDiarizationFailure(toast);
}

/** Payload of the native `diarization-unavailable` event. */
export interface DiarizationUnavailablePayload {
  /** The meeting the pass ran for; absent on events from older callers. */
  meeting_id?: string;
  /** Why the pass did not produce labels. */
  status?: DiarizationStatus;
  /** Diagnostic detail; never user-facing prose. */
  reason?: string | null;
  /** User-facing explanation, owned by native code. */
  message?: string;
}

/**
 * Whether an incoming `diarization-unavailable` event is worth a toast.
 *
 * Native code emits this event only for `failed`, but the listeners check the
 * payload status instead of assuming that: if the native contract is ever
 * widened, automatic passes stay silent for configuration reasons and only a
 * real failure speaks up. Kept as one helper so import and retranscription
 * cannot drift from the automatic-pass rule.
 */
export function shouldToastDiarizationUnavailable(
  status: DiarizationStatus | undefined,
): boolean {
  return status !== undefined && shouldToastDiarizationStatus(status);
}

/**
 * Explanation of a status for an explicit run, or `null` after a pass.
 *
 * Unlike the automatic path, the panel shows the reason for every refusal: it
 * answers a button the user pressed.
 */
export function diarizationStatusMessage(status: DiarizationStatus): string | null {
  switch (status) {
    case 'ran':
      return null;
    case 'no_model':
      return DIARIZATION_NO_MODEL_MESSAGE;
    case 'no_runtime':
      return DIARIZATION_NO_RUNTIME_MESSAGE;
    case 'deferred':
      return DIARIZATION_DEFERRED_MESSAGE;
    case 'failed':
      return DIARIZATION_FAILED_MESSAGE;
  }
}

/**
 * Whether a catalogued model can actually diarize: the `diar` task with an
 * installed artifact. Mirrors the native selection rule, so the manual run
 * button is disabled exactly when the pass would answer `no_model`.
 */
export function hasInstalledDiarizationModel(
  models: Array<Pick<AudioCppModelInfo, 'task' | 'status'>>,
): boolean {
  return models.some((model) => model.task === 'diar' && model.status === 'Available');
}
