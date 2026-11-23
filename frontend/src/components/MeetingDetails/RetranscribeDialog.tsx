import React, { useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore } from 'react';
import { RefreshCw, Globe, Loader2, AlertCircle, CheckCircle2, X, Cpu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import {
  DIARIZATION_BAND_START,
  diarizationStageMessage,
  shouldToastDiarizationUnavailable,
  showDiarizationFailure,
  type DiarizationPassStore,
  type DiarizationUnavailablePayload,
} from '@/lib/diarization';
import { diarizationPassStore as defaultPassStore } from '@/lib/diarizationPassStore';
import {
  checkDiarizationAvailability,
  defaultDiarizationAvailabilityClient,
  retranscriptionBarPercentage,
  type DiarizationAvailabilityClient,
} from '@/lib/diarizationAvailability';
import { useConfig } from '@/contexts/ConfigContext';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';

interface RetranscribeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: string;
  meetingFolderPath: string | null;
  /**
   * Fires when the new transcript is committed, before the diarization pass.
   */
  onComplete?: () => void;
  /**
   * Shared diarization pass state seam; production reads the singleton so the
   * bar's diarization band is the same state the speakers panel shows.
   */
  passStore?: DiarizationPassStore;
  /** Catalog + runtime probe seam; the same knowledge the speakers panel has. */
  availabilityClient?: DiarizationAvailabilityClient;
  /**
   * Tauri `invoke` seam for the two commands this dialog owns; production
   * loads it lazily (the diarization seam pattern) so unit tests that inject
   * a fake never touch the native bridge — or depend on the bun module-
   * registry state a sibling suite may have left behind.
   */
  invokeImpl?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

interface RetranscriptionProgress {
  meeting_id: string;
  stage: string;
  progress_percentage: number;
  message: string;
}

interface RetranscriptionResult {
  meeting_id: string;
  segments_count: number;
  duration_seconds: number;
  language: string | null;
}

interface RetranscriptionError {
  meeting_id: string;
  error: string;
}

/**
 * The synthetic stage the bar enters once the transcript is saved and the
 * diarization band (75..100 of the scale) begins. The native
 * `retranscription-progress` channel is untouched; this is a frontend-side
 * bar state, localized here so the dialog prints the same sentence the
 * speakers panel uses for the phase.
 */
const RETRANSCRIPTION_DIARIZING_STAGE = 'diarizing';

/**
 * The top of the native scale, the bottom of the diarization band, imported
 * from the seam (`DIARIZATION_BAND_START`) so the dialog and the native
 * milestones share one number.
 */

/** Production seam: Tauri's `invoke`, imported lazily so importing this
 * component never touches the native bridge (the diarization seam pattern). */
type InvokeImpl = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const tauriInvoke: InvokeImpl = async (command, args) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
};

export function RetranscribeDialog({
  open,
  onOpenChange,
  meetingId,
  meetingFolderPath,
  onComplete,
  passStore = defaultPassStore,
  availabilityClient = defaultDiarizationAvailabilityClient,
  invokeImpl = tauriInvoke,
}: RetranscribeDialogProps) {
  const { t } = useTranslation();
  const { transcriptModelConfig } = useConfig();
  // The transcript is still being produced: closing is blocked and Cancel
  // aborts the retranscription.
  const [isProcessing, setIsProcessing] = useState(false);
  // The transcript is saved and the bar holds the diarization band: closing
  // is allowed and never interrupts the detached pass.
  const [isDiarizing, setIsDiarizing] = useState(false);
  // Everything, diarization included, is finished: "Done" is on screen.
  const [isComplete, setIsComplete] = useState(false);
  const [progress, setProgress] = useState<RetranscriptionProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  // Stable refs for callbacks to avoid listener re-registration
  const onCompleteRef = useRef(onComplete);
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

  // Track previous open state to only reset on closed→open transition
  const prevOpenRef = useRef(false);

  // Whether a diarization pass is expected for this retranscription: the
  // frontend knows about the model and the runtime the same way the speakers
  // panel does. `false` means the native decision will be a silent
  // `no_model`/`no_runtime`, so completion must not wait for a terminal that
  // can never arrive. `null` means the check has not answered yet; an
  // unreadable catalog keeps it `null` (unknown never reads as "no model").
  const diarizationExpectedRef = useRef<boolean | null>(null);

  // The `retranscription-complete` result held until the pass reaches its
  // terminal (or the verdict that no pass will run).
  const pendingCompleteRef = useRef<RetranscriptionResult | null>(null);
  // Written through refs so the store subscription (registered per watch)
  // always runs the current settle logic.
  const settleRef = useRef<() => void>(() => {});
  // Watching window: opens when the transcript is saved, closes when the run
  // completes, fails or is reset. A finished run needs no store
  // subscription, and an idle dialog must not occupy the shared pass
  // listener: closing the dialog itself is NOT the end of the watch — only a
  // settle is — so a detached pass keeps notifying the bar while the dialog
  // is closed.
  const [watchingPass, setWatchingPass] = useState(false);

  /** Releases the held completion when the pass is over. */
  const settleCompletion = () => {
    const pending = pendingCompleteRef.current;
    if (!pending) return;
    const waiting =
      diarizationExpectedRef.current !== false && !passStore.hasSeenTerminal(pending.meeting_id);
    if (waiting) return;
    pendingCompleteRef.current = null;
    setWatchingPass(false);
    setIsDiarizing(false);
    setIsComplete(true);
    setProgress(null);
    toast.success(
      i18n.t('retranscribe.completeToast', { count: pending.segments_count })
    );
  };
  settleRef.current = settleCompletion;

  // One store subscription serves the bar and the completion rule. The store
  // runs the single `diarization-progress` listener plus the three terminals
  // and notifies on every event; the pass state is read through
  // `useSyncExternalStore`, so the dialog never registers its own
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
    () => (watchingPass ? passStore.getState(meetingId) : null),
    [passStore, watchingPass, meetingId],
  );
  const passState = useSyncExternalStore(subscribePass, readPass, () => null);

  // Helper to get selected model details (memoized)
  const selectedModelDetails = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find(m => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  // transcribe.cpp is the only engine: it detects the language itself, so the
  // dialog offers no language choice and always sends autodetect.

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    if (open && !wasOpen) {
      resetSelection();
      setIsProcessing(false);
      setIsDiarizing(false);
      setIsComplete(false);
      setProgress(null);
      setError(null);
      diarizationExpectedRef.current = null;
      pendingCompleteRef.current = null;
      setWatchingPass(false);

      // Fetch available models using centralized hook
      fetchModels();
    }
  }, [open, transcriptModelConfig, fetchModels]);

  // Listen for retranscription events
  useEffect(() => {
    if (!open) return;

    const unlisteners: UnlistenFn[] = [];
    const cleanedUpRef = { current: false };

    const setupListeners = async () => {
      // Progress events
      const unlistenProgress = await listen<RetranscriptionProgress>(
        'retranscription-progress',
        (event) => {
          if (event.payload.meeting_id === meetingId) {
            setProgress(event.payload);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenProgress();
        return;
      }
      unlisteners.push(unlistenProgress);

      // Completion event. Despite the name, the transcript is only saved
      // here: the diarization pass is scheduled by native code at this
      // moment, so "Готово" waits for the pass's terminal unless no pass
      // will run.
      const unlistenComplete = await listen<RetranscriptionResult>(
        'retranscription-complete',
        (event) => {
          if (event.payload.meeting_id !== meetingId) return;
          const result = event.payload;

          // The transcript is saved: the bar enters the diarization band and
          // the dialog becomes closable; the detached pass continues whether
          // the dialog stays open or not.
          setIsProcessing(false);
          setIsDiarizing(true);
          setProgress({
            meeting_id: meetingId,
            stage: RETRANSCRIPTION_DIARIZING_STAGE,
            progress_percentage: DIARIZATION_BAND_START,
            message: i18n.t('retranscribe.stages.diarizing'),
          });

          pendingCompleteRef.current = result;
          setWatchingPass(true);
          // The new transcript is committed: the meeting screen can refresh
          // it while the pass keeps running.
          onCompleteRef.current?.();

          void (async () => {
            if (diarizationExpectedRef.current === null) {
              const availability = await checkDiarizationAvailability(availabilityClient);
              // `unknown` (a failed read) is not knowledge of a missing
              // model: keep waiting for the pass instead of ending the bar
              // on a guess.
              if (availability !== 'unknown') {
                diarizationExpectedRef.current = availability === 'available';
              }
            }
            settleRef.current();
          })();
        }
      );
      if (cleanedUpRef.current) {
        unlistenComplete();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenComplete);

      // Error event
      const unlistenError = await listen<RetranscriptionError>(
        'retranscription-error',
        (event) => {
          if (event.payload.meeting_id === meetingId) {
            pendingCompleteRef.current = null;
            setWatchingPass(false);
            setIsProcessing(false);
            setIsDiarizing(false);
            setError(event.payload.error);
          }
        }
      );
      if (cleanedUpRef.current) {
        unlistenError();
        unlisteners.forEach(u => u());
        return;
      }
      unlisteners.push(unlistenError);

      // A diarization pass that was attempted and failed. Native code emits
      // this event only for `failed`, and the status check keeps the dialog
      // silent for configuration reasons if that contract is ever widened.
      const unlistenDiarization = await listen<DiarizationUnavailablePayload>(
        'diarization-unavailable',
        (event) => {
          if (event.payload.meeting_id && event.payload.meeting_id !== meetingId) return;
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
      // Dropping the listeners never touches the held completion: the
      // component stays mounted while the dialog is merely closed, the
      // native task is detached, and the terminal must still release the
      // completion (and the toast) after a close. A reopen resets through
      // the closed→open effect.
    };
    // The store and the availability client are stable production
    // singletons; the effect stays registration-per-open like the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, meetingId]);

  const handleStartRetranscription = async () => {
    if (!meetingFolderPath) {
      setError(t('retranscribe.folderPathMissing'));
      return;
    }

    setIsProcessing(true);
    setError(null);
    setProgress(null);
    setIsComplete(false);
    setIsDiarizing(false);
    diarizationExpectedRef.current = null;
    pendingCompleteRef.current = null;
    // Forget whatever the store learned about earlier passes for this
    // meeting: a retranscription always re-runs the pass (native code deletes
    // and rewrites the labels), so a terminal from an earlier pass must not
    // release this run's completion before the new pass has spoken.
    passStore.clear(meetingId);

    // Start the availability reads with the run: by the time the transcript
    // is saved the verdict is usually already in, and the bar knows whether a
    // diarization pass is coming at all.
    void (async () => {
      const availability = await checkDiarizationAvailability(availabilityClient);
      if (availability === 'unknown') return;
      // Only a verdict for a still-current run counts; a late answer must
      // not skip the next run's completion either.
      if (diarizationExpectedRef.current === null) {
        diarizationExpectedRef.current = availability === 'available';
        // The answer may arrive after the save already checked and is now
        // waiting on the pass: re-run the release rule.
        settleRef.current();
      }
    })();

    try {
      // transcribe.cpp detects the language itself: the batch path receives
      // no hint, the same as the live pipeline's autodetect.
      await invokeImpl('start_retranscription_command', {
        meetingId,
        meetingFolderPath,
        language: null,
        model: selectedModelDetails?.name || null,
        provider: selectedModelDetails?.provider || null,
      });
    } catch (err: any) {
      setIsProcessing(false);
      pendingCompleteRef.current = null;
      const errorMsg = typeof err === 'string' ? err : (err?.message || String(err));
      setError(errorMsg);
    }
  };

  const handleCancel = async () => {
    // Only the transcription is cancellable; there is no diarization cancel,
    // and by the time the bar enters the diarization band the retranscription
    // itself is over (this path closes the dialog, it never aborts the pass).
    if (isProcessing) {
      try {
        await invokeImpl('cancel_retranscription_command');
        setIsProcessing(false);
        setProgress(null);
        pendingCompleteRef.current = null;
        toast.info(i18n.t('retranscribe.cancelledToast'));
      } catch (err) {
        console.error('Failed to cancel retranscription:', err);
      }
    }
    onOpenChange(false);
  };

  // The transcript is still being produced: the dialog must not be closed
  // and Cancel aborts the retranscription. The diarization phase is
  // deliberately NOT part of this — it is a detached pass the dialog does
  // not own.
  const isTranscribing = isProcessing;
  const inProgress = isProcessing || isDiarizing;

  // Prevent closing while the transcript is still being produced; during
  // diarization closing is allowed and never interrupts the pass.
  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen && isTranscribing) {
      return;
    }
    onOpenChange(newOpen);
  };

  const handleEscapeKeyDown = (event: KeyboardEvent) => {
    if (isTranscribing) {
      event.preventDefault();
    }
  };

  const handleInteractOutside = (event: Event) => {
    if (isTranscribing) {
      event.preventDefault();
    }
  };

  // The bar: native milestones carry it to 75; from there the shared pass
  // state maps the honest pass percentage into 75..100 (an indeterminate
  // stage sits at 75), and the finished run reads 100.
  const barPercent = isComplete
    ? 100
    : retranscriptionBarPercentage(progress?.progress_percentage ?? null, passState);
  // The stage caption: the native stage word while the transcript is being
  // produced (as before); from the save on, the shared pass state's stage
  // sentence, falling back to the diarization sentence before the pass speaks.
  const barStage = isComplete
    ? t('retranscribe.stages.complete')
    : passState && passState.phase === 'running'
      ? diarizationStageMessage(passState.stage!)
      : progress?.stage === RETRANSCRIPTION_DIARIZING_STAGE
        ? t('retranscribe.stages.diarizing')
        : progress?.stage ?? '';
  const barMessage = isComplete
    ? t('retranscribe.stages.complete')
    : progress?.message ?? t('retranscribe.descriptionProcessing');
  const showBar = !error && (inProgress || isComplete);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[450px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {inProgress ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {t('retranscribe.titleProcessing')}
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                {t('retranscribe.titleFailed')}
              </>
            ) : (
              <>
                <RefreshCw className="h-5 w-5 text-blue-600" />
                {t('retranscribe.title')}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {inProgress
              ? progress?.message || t('retranscribe.descriptionProcessing')
              : error
                ? t('retranscribe.descriptionFailed')
                : t('retranscribe.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!inProgress && !error && !isComplete && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t('retranscribe.languageLabel')}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('retranscribe.languageTranscribeCppHint')}
              </p>
            </div>
          )}

          {!inProgress && !error && !isComplete && availableModels.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Cpu className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-medium">{t('retranscribe.modelLabel')}</span>
              </div>
              <Select value={selectedModelKey} onValueChange={setSelectedModelKey} disabled={loadingModels}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={loadingModels ? t('retranscribe.loadingModels') : t('retranscribe.selectModel')} />
                </SelectTrigger>
                <SelectContent>
                  {availableModels.map((model) => (
                    <SelectItem key={`${model.provider}:${model.name}`} value={`${model.provider}:${model.name}`}>
                      {model.displayName} ({Math.round(model.size_mb)} MB)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('retranscribe.modelHint')}
              </p>
            </div>
          )}

          {/* Progress display. Transcription runs to 75 on native milestones;
              the diarization band 75..100 comes from the shared pass state,
              so the bar no longer ends at transcription. */}
          {showBar && (
            <div className="space-y-2">
              <div className="relative">
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-300 ease-out"
                    style={{ width: `${Math.min(barPercent, 100)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs text-gray-600 mt-1">
                  <span>{barStage}</span>
                  <span>{Math.round(barPercent)}%</span>
                </div>
              </div>
              <p className="text-sm text-muted-foreground text-center">
                {barMessage}
              </p>
              {isDiarizing && (
                <p className="text-xs text-muted-foreground text-center">
                  {t('retranscribe.diarizationHint')}
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!inProgress && !error && !isComplete && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleStartRetranscription}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!meetingFolderPath}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('retranscribe.start')}
              </Button>
            </>
          )}
          {isTranscribing && (
            <Button variant="outline" onClick={handleCancel}>
              <X className="h-4 w-4 mr-2" />
              {t('common.cancel')}
            </Button>
          )}
          {isDiarizing && (
            // Closing here does not touch the pass: it is detached on the
            // native side, and the speakers panel keeps showing its state.
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.close')}
            </Button>
          )}
          {isComplete && (
            <Button onClick={() => onOpenChange(false)} className="bg-blue-600 hover:bg-blue-700">
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {t('retranscribe.actions.done')}
            </Button>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
              <Button
                onClick={() => {
                  setError(null);
                  setProgress(null);
                }}
                variant="outline"
              >
                {t('retranscribe.tryAgain')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
