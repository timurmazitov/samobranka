import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { applyPinnedSummaryLanguageToMeeting } from '@/lib/summary-language-preferences';
import {
  DIARIZATION_BAND_START,
  shouldToastDiarizationUnavailable,
  showDiarizationFailure,
  type DiarizationPassState,
  type DiarizationPassStore,
  type DiarizationUnavailablePayload,
} from '@/lib/diarization';
import { diarizationPassStore as defaultPassStore } from '@/lib/diarizationPassStore';
import {
  checkDiarizationAvailability,
  defaultDiarizationAvailabilityClient,
  type DiarizationAvailabilityClient,
} from '@/lib/diarizationAvailability';
import { toast } from 'sonner';
import i18n from '@/i18n';

export interface AudioFileInfo {
  path: string;
  filename: string;
  duration_seconds: number;
  size_bytes: number;
  format: string;
}

export interface ImportProgress {
  stage: string;
  progress_percentage: number;
  message: string;
  /** Stable i18n code added by the native side (spec D7); see `lib/native-progress`. */
  code?: string;
  params?: Record<string, unknown>;
}

export interface ImportResult {
  meeting_id: string;
  title: string;
  segments_count: number;
  duration_seconds: number;
}

export interface ImportError {
  error: string;
}

export type ImportStatus = 'idle' | 'validating' | 'processing' | 'complete' | 'error';

/**
 * The synthetic stage the bar enters once the transcript is saved and the
 * diarization band (75..100 of the scale) begins. The native `import-progress`
 * channel is untouched; this is a frontend-side bar state, localized here so
 * the dialog prints the same sentence the speakers panel uses for the phase.
 */
export const IMPORT_DIARIZING_STAGE = 'diarizing';

export interface UseImportAudioOptions {
  /** Fires when the meeting is saved, before the diarization pass. */
  onSaved?: (result: ImportResult) => void;
  /** Fires when everything, diarization included, is finished. */
  onComplete?: (result: ImportResult) => void;
  onError?: (error: string) => void;
  /**
   * Shared diarization pass state seam (production uses the singleton). The
   * hook reads the pass here — it never listens to `diarization-progress`
   * itself — and never clears it: closing this dialog leaves the pass visible
   * to the speakers panel.
   */
  passStore?: DiarizationPassStore;
  /** Catalog + runtime probe seam; the same knowledge the speakers panel has. */
  availabilityClient?: DiarizationAvailabilityClient;
}

export interface UseImportAudioReturn {
  status: ImportStatus;
  fileInfo: AudioFileInfo | null;
  progress: ImportProgress | null;
  error: string | null;
  /** Transcript still being produced; the dialog must not be closed then. */
  isProcessing: boolean;
  isBusy: boolean;
  /**
   * The transcript is saved and the bar has entered the diarization band:
   * the dialog may be closed, the detached pass continues, and the speakers
   * panel keeps the state.
   */
  isDiarizing: boolean;
  /** The meeting's live pass state from the shared store, for the bar. */
  passState: DiarizationPassState | null;
  selectFile: () => Promise<AudioFileInfo | null>;
  validateFile: (path: string) => Promise<AudioFileInfo | null>;
  startImport: (
    sourcePath: string,
    title: string,
    language?: string | null,
    model?: string | null,
    provider?: 'transcribeCpp' | null
  ) => Promise<void>;
  cancelImport: () => Promise<void>;
  reset: () => void;
}

export function useImportAudio({
  onSaved,
  onComplete,
  onError,
  passStore = defaultPassStore,
  availabilityClient = defaultDiarizationAvailabilityClient,
}: UseImportAudioOptions = {}): UseImportAudioReturn {
  const [status, setStatus] = useState<ImportStatus>('idle');
  const [fileInfo, setFileInfo] = useState<AudioFileInfo | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable refs for callbacks to avoid listener re-registration on every render
  const onSavedRef = useRef(onSaved);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  useEffect(() => { onSavedRef.current = onSaved; }, [onSaved]);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  // Cancellation guard: prevents late events from updating state after cancel
  const isCancelledRef = useRef(false);

  // The meeting this dialog's import produced. The diarization listener is
  // process-wide, so without it a failed pass for any other meeting would toast
  // inside the open dialog. Filled by `import-complete`, which is the first
  // moment the id exists.
  const importedMeetingIdRef = useRef<string | null>(null);

  // Whether a diarization pass is expected for the meeting being imported:
  // the frontend knows about the model and the runtime the same way the
  // speakers panel does. `false` means the native decision will be a silent
  // `no_model`/`no_runtime`, so completion must not wait for a terminal that
  // can never arrive. `null` means the check has not answered yet; an
  // unreadable catalog keeps it `null` (unknown never reads as "no model").
  const diarizationExpectedRef = useRef<boolean | null>(null);

  // The `import-complete` result held until the pass reaches its terminal.
  const pendingCompleteRef = useRef<{ meetingId: string; result: ImportResult } | null>(null);
  // Written through refs so the store subscription (registered per watch)
  // always runs the current settle logic.
  const settleRef = useRef<() => void>(() => {});
  // Watching window: opens with an import, closes when it completes, fails,
  // is cancelled or reset. A finished import needs no store subscription,
  // and an idle dialog must not occupy the shared pass listener: closing the
  // dialog itself is NOT the end of the watch — only a settle is — so a
  // detached pass keeps notifying the bar while the dialog is closed.
  const [watchingPass, setWatchingPass] = useState(false);

  /** Releases the held completion when the pass is over. */
  const settleCompletion = useCallback(() => {
    const pending = pendingCompleteRef.current;
    if (!pending) return;
    const waiting =
      diarizationExpectedRef.current !== false && !passStore.hasSeenTerminal(pending.meetingId);
    if (waiting) return;
    pendingCompleteRef.current = null;
    setWatchingPass(false);
    setStatus('complete');
    setProgress(null);
    onCompleteRef.current?.(pending.result);
  }, [passStore]);
  settleRef.current = settleCompletion;

  // One store subscription serves the bar and the completion rule. The store
  // runs the single `diarization-progress` listener plus the three terminals
  // and notifies on every event; the pass state is read through
  // `useSyncExternalStore`, so the hook never registers its own
  // `diarization-progress` listener and the pass survives this dialog.
  const subscribePass = useCallback(
    (onChange: () => void) => {
      if (!watchingPass) return () => {};
      return passStore.subscribe(() => {
        onChange();
        settleRef.current();
      });
    },
    [passStore, watchingPass],
  );
  const readPass = useCallback(
    () =>
      watchingPass && importedMeetingIdRef.current
        ? passStore.getState(importedMeetingIdRef.current)
        : null,
    [passStore, watchingPass],
  );
  const passState = useSyncExternalStore(subscribePass, readPass, () => null);

  // Set up event listeners (registered once, use refs for callbacks)
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<ImportProgress>(
        'import-progress',
        (event) => {
          if (isCancelledRef.current) return;
          setProgress(event.payload);
          setStatus('processing');
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event. Despite the name, the meeting is only saved here:
      // the diarization pass is scheduled by native code at this moment, so
      // "Готово" waits for the pass's terminal unless no pass will run.
      const unlistenComplete = await listen<ImportResult>(
        'import-complete',
        async (event) => {
          if (isCancelledRef.current) return;
          const result = event.payload;
          importedMeetingIdRef.current = result.meeting_id;
          onSavedRef.current?.(result);

          // The transcript is saved: the bar enters the diarization band and
          // the dialog becomes closable; the detached pass continues whether
          // the dialog stays open or not. The band start is the same number
          // the native milestones stop at (`import.rs`'s `DIARIZATION_BAND_START`).
          setProgress({
            stage: IMPORT_DIARIZING_STAGE,
            progress_percentage: DIARIZATION_BAND_START,
            message: i18n.t('importAudio.stages.diarizing'),
          });

          pendingCompleteRef.current = { meetingId: result.meeting_id, result };
          try {
            await applyPinnedSummaryLanguageToMeeting(result.meeting_id);
          } catch (error) {
            console.warn('Failed to apply pinned summary language to imported meeting:', error);
            toast.warning(i18n.t('toasts.summaryLanguage.pinned'), {
              description: i18n.t('toasts.summaryLanguage.pinnedDescriptionImported'),
            });
          }
          if (isCancelledRef.current) return;
          if (importedMeetingIdRef.current !== result.meeting_id) return;

          if (diarizationExpectedRef.current === null) {
            const availability = await checkDiarizationAvailability(availabilityClient);
            // `unknown` (a failed read) is not knowledge of a missing model:
            // keep waiting for the pass instead of ending the bar on a guess.
            if (availability !== 'unknown') {
              diarizationExpectedRef.current = availability === 'available';
            }
          }
          if (isCancelledRef.current) return;
          if (importedMeetingIdRef.current !== result.meeting_id) return;
          settleCompletion();
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<ImportError>(
        'import-error',
        (event) => {
          if (isCancelledRef.current) return;

          pendingCompleteRef.current = null;
          setWatchingPass(false);
          setStatus('error');
          setError(event.payload.error);
          onErrorRef.current?.(event.payload.error);
        }
      );
      if (cleanedUpRef.current) {
        unlistenError();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenError);

      // A diarization pass that was attempted and failed. Native code emits
      // this event only for `failed`; the status check keeps the hook silent
      // for configuration reasons if that contract is ever widened. The
      // transcript is already complete, so this is never an error state. Only
      // this import's meeting speaks: the event is process-wide, and a failure
      // from another meeting must not surface in the open dialog.
      const unlistenDiarization = await listen<DiarizationUnavailablePayload>(
        'diarization-unavailable',
        (event) => {
          if (isCancelledRef.current) return;
          if (
            importedMeetingIdRef.current === null ||
            event.payload.meeting_id !== importedMeetingIdRef.current
          ) {
            return;
          }
          if (!shouldToastDiarizationUnavailable(event.payload.status)) return;
          showDiarizationFailure(toast, event.payload);
        }
      );
      if (cleanedUpRef.current) {
        unlistenDiarization();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenDiarization);
    };

    setupListeners();

    return () => {
      cleanedUpRef.current = true;
      unlisteners.forEach((unlisten) => unlisten());
      // Dropping the hook's view never touches the pass itself: the native
      // task is detached, and the store subscription the speakers panel holds
      // keeps the shared state alive.
      pendingCompleteRef.current = null;
    };
    // The store and the availability client are stable production
    // singletons; the effect stays registration-once like the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Select file using native file dialog
  const selectFile = useCallback(async (): Promise<AudioFileInfo | null> => {
    setStatus('validating');
    setError(null);

    try {
      const result = await invoke<AudioFileInfo | null>('select_and_validate_audio_command');
      if (result) {
        setFileInfo(result);
        setStatus('idle');
        return result;
      } else {
        // User cancelled
        setStatus('idle');
        return null;
      }
    } catch (err: any) {
      setStatus('error');
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to validate file');
      setError(errorMsg);
      onErrorRef.current?.(errorMsg);
      return null;
    }
  }, []);

  // Validate a file from a given path (for drag-drop)
  const validateFile = useCallback(async (path: string): Promise<AudioFileInfo | null> => {
    setStatus('validating');
    setError(null);

    try {
      const result = await invoke<AudioFileInfo>('validate_audio_file_command', { path });
      setFileInfo(result);
      setStatus('idle');
      return result;
    } catch (err: any) {
      setStatus('error');
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to validate file');
      setError(errorMsg);
      onErrorRef.current?.(errorMsg);
      return null;
    }
  }, []);

  // Start the import process
  const startImport = useCallback(
    async (
      sourcePath: string,
      title: string,
      language?: string | null,
      model?: string | null,
      provider?: string | null
    ) => {
      isCancelledRef.current = false;
      // A new import starts before its meeting id exists; the previous
      // import's meeting must not claim a failure from this one.
      importedMeetingIdRef.current = null;
      // Re-check availability for every import: a model may have been
      // downloaded or removed since the last one.
      diarizationExpectedRef.current = null;
      pendingCompleteRef.current = null;
      setWatchingPass(true);
      setStatus('processing');
      setError(null);
      setProgress(null);

      // Start the availability reads with the import: by the time the
      // transcript is saved the verdict is usually already in, and the bar
      // knows whether a diarization pass is coming at all.
      void (async () => {
        const availability = await checkDiarizationAvailability(availabilityClient);
        if (availability === 'unknown') return;
        // Only a verdict for a still-current import counts; a late answer
        // must not skip the next import's completion either.
        if (diarizationExpectedRef.current === null) {
          diarizationExpectedRef.current = availability === 'available';
          // The answer may arrive after `import-complete` already checked and
          // is now waiting on the pass: re-run the release rule.
          settleRef.current();
        }
      })();

      try {
        await invoke('start_import_audio_command', {
          sourcePath,
          title,
          language: language || null,
          model: model || null,
          provider: provider || null,
        });
      } catch (err: any) {
        setStatus('error');
        const errorMsg = typeof err === 'string' ? err : (err?.message || String(err) || 'Failed to start import');
        setError(errorMsg);

        onErrorRef.current?.(errorMsg);
      }
    },
    [availabilityClient]
  );

  // Cancel ongoing import
  const cancelImport = useCallback(async () => {
    isCancelledRef.current = true;
    pendingCompleteRef.current = null;
    try {
      await invoke('cancel_import_command');
      setStatus('idle');
      setProgress(null);
    } catch (err: any) {
      console.error('Failed to cancel import:', err);
    }
  }, []);

  // Reset all state
  const reset = useCallback(() => {
    isCancelledRef.current = false;
    importedMeetingIdRef.current = null;
    diarizationExpectedRef.current = null;
    pendingCompleteRef.current = null;
    setStatus('idle');
    setFileInfo(null);
    setProgress(null);
    setError(null);
  }, []);

  return {
    status,
    fileInfo,
    progress,
    error,
    isProcessing: status === 'processing' && progress?.stage !== IMPORT_DIARIZING_STAGE,
    isBusy: status === 'processing' || status === 'validating',
    isDiarizing: status === 'processing' && progress?.stage === IMPORT_DIARIZING_STAGE,
    passState,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  };
}
