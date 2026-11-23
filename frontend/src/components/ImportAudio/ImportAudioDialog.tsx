import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import i18n, { type AppLanguageCode } from '@/i18n';
import { formatDecimal, formatMegabytes } from '@/lib/format-locale';
import {
  Upload,
  Globe,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Cpu,
  FileAudio,
  Clock,
  HardDrive,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportAudio, ImportResult } from '@/hooks/useImportAudio';
import { useRouter } from 'next/navigation';
import { useSidebar } from '../Sidebar/SidebarProvider';
import { useTranscriptionModels, ModelOption } from '@/hooks/useTranscriptionModels';
import { diarizationStageMessage, type DiarizationPassStore } from '@/lib/diarization';
import { diarizationPassStore as defaultPassStore } from '@/lib/diarizationPassStore';
import {
  defaultDiarizationAvailabilityClient,
  importBarPercentage,
  type DiarizationAvailabilityClient,
} from '@/lib/diarizationAvailability';

interface ImportAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedFile?: string | null;
  onComplete?: () => void;
  /**
   * Shared diarization pass state seam; production reads the singleton so the
   * bar's diarization band is the same state the speakers panel shows.
   */
  passStore?: DiarizationPassStore;
  /** Catalog + runtime probe seam; the same knowledge the speakers panel has. */
  availabilityClient?: DiarizationAvailabilityClient;
}


function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes: number, language: AppLanguageCode): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${formatDecimal(bytes / 1024, language, 1)} KB`;
  return formatMegabytes(bytes / (1024 * 1024), language);
}

export function ImportAudioDialog({
  open,
  onOpenChange,
  preselectedFile,
  onComplete,
  passStore = defaultPassStore,
  availabilityClient = defaultDiarizationAvailabilityClient,
}: ImportAudioDialogProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const language = i18n.language as AppLanguageCode;
  const { refetchMeetings } = useSidebar();
  const { transcriptModelConfig } = useConfig();

  const [title, setTitle] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [titleModifiedByUser, setTitleModifiedByUser] = useState(false);
  // The meeting the last completed import produced; "Done" navigates there.
  const lastMeetingIdRef = useRef<string | null>(null);

  // Always start as false — represents "dialog has not yet been opened".
  // Do NOT initialize from the `open` prop: if the component mounts with open=true
  // (e.g. drag-drop path), we still need the initialization effect to run.
  const prevOpenRef = useRef(false);

  // Use centralized model fetching hook
  const {
    availableModels,
    selectedModelKey,
    setSelectedModelKey,
    loadingModels,
    fetchModels,
    resetSelection,
  } = useTranscriptionModels(transcriptModelConfig);

  const handleImportSaved = useCallback(() => {
    // The meeting row and transcript exist from this moment: the list can
    // show it while the detached diarization pass keeps running.
    refetchMeetings();
    onComplete?.();
  }, [refetchMeetings, onComplete]);

  const handleImportComplete = useCallback((result: ImportResult) => {
    // The diarization terminal (or the decision that no pass will run)
    // arrived: only now does the dialog say the import is complete.
    toast.success(t('importAudio.toast.complete', { count: result.segments_count }));
    lastMeetingIdRef.current = result.meeting_id;
  }, [t]);

  /** Closes the dialog and opens the imported meeting; the pass, if any,
   * keeps running and the speakers panel shows it. */
  const goToImportedMeeting = useCallback(() => {
    onOpenChange(false);
    if (lastMeetingIdRef.current) {
      router.push(`/meeting-details?id=${lastMeetingIdRef.current}`);
    }
  }, [onOpenChange, router]);

  const handleImportError = useCallback((error: string) => {
    toast.error(t('importAudio.toast.failed'), { description: error });
  }, [t]);

  const {
    status,
    fileInfo,
    progress,
    error,
    isProcessing,
    isBusy,
    isDiarizing,
    passState,
    selectFile,
    validateFile,
    startImport,
    cancelImport,
    reset,
  } = useImportAudio({
    onSaved: handleImportSaved,
    onComplete: handleImportComplete,
    onError: handleImportError,
    passStore,
    availabilityClient,
  });

  // Reset state only when dialog transitions from closed to open
  // This prevents re-initialization when config changes while dialog is already open (Bug #4 & #5)
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = open;

    // Only initialize when transitioning from closed (false) to open (true)
    if (open && !wasOpen) {
      reset();
      resetSelection();
      setTitle('');
      setTitleModifiedByUser(false);
      setShowAdvanced(false);
      lastMeetingIdRef.current = null;

      // Validate preselected file if provided
      if (preselectedFile) {
        validateFile(preselectedFile).then((info) => {
          if (info) {
            setTitle(info.filename);
          }
        });
      }

      // Fetch available models using centralized hook
      fetchModels();
    }
  }, [open, preselectedFile, transcriptModelConfig, reset, resetSelection, validateFile, fetchModels]);

  // Update title when fileInfo changes
  useEffect(() => {
    if (fileInfo && !title && !titleModifiedByUser) {
      setTitle(fileInfo.filename);
    }
  }, [fileInfo, title, titleModifiedByUser]);

  const selectedModel = useMemo((): ModelOption | undefined => {
    if (!selectedModelKey) return undefined;
    const colonIndex = selectedModelKey.indexOf(':');
    if (colonIndex === -1) return undefined;
    const provider = selectedModelKey.slice(0, colonIndex);
    const name = selectedModelKey.slice(colonIndex + 1);
    return availableModels.find((m) => m.provider === provider && m.name === name);
  }, [selectedModelKey, availableModels]);
  // transcribe.cpp is the only engine: it detects the language itself, so the
  // import offers no language choice and always sends autodetect.

  const handleSelectFile = async () => {
    const info = await selectFile();
    if (info) {
      setTitle(info.filename);
    }
  };

  const handleStartImport = async () => {
    if (!fileInfo) return;

    await startImport(
      fileInfo.path,
      title || fileInfo.filename,
      // transcribe.cpp detects the language itself: the batch path receives
      // no hint, the same as the live pipeline's autodetect.
      null,
      selectedModel?.name || null,
      selectedModel?.provider || null
    );
  };

  const handleCancel = async () => {
    if (isProcessing) {
      await cancelImport();
      toast.info(t('importAudio.toast.cancelled'));
    }
    onOpenChange(false);
  };

  // The transcript is still being produced: the dialog must not be closed
  // and Cancel aborts the import. The diarization phase is deliberately NOT
  // part of this — it is a detached pass the dialog does not own.
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
  // stage sits at 75), and the finished import reads 100.
  const barPercent = status === 'complete'
    ? 100
    : importBarPercentage(progress?.progress_percentage ?? null, passState);
  // The stage caption: the native stage word while the transcript is being
  // produced (as before); from the save on, the shared pass state's stage
  // sentence, falling back to the diarization sentence before the pass speaks.
  const barStage = status === 'complete'
    ? t('importAudio.stages.complete')
    : passState
      ? diarizationStageMessage(passState.stage)
      : isDiarizing
        ? t('importAudio.stages.diarizing')
        : progress?.stage ?? t('importAudio.stages.diarizing');
  const barMessage =
    status === 'complete'
      ? t('importAudio.stages.complete')
      : progress?.message ??
        (passState ? diarizationStageMessage(passState.stage) : t('importAudio.stages.diarizing'));
  const showBar = !error && (inProgress || status === 'complete');

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        onEscapeKeyDown={handleEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {inProgress ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                {t('importAudio.title.importing')}
              </>
            ) : error ? (
              <>
                <AlertCircle className="h-5 w-5 text-red-600" />
                {t('importAudio.title.failed')}
              </>
            ) : status === 'complete' ? (
              <>
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                {t('importAudio.title.complete')}
              </>
            ) : (
              <>
                <Upload className="h-5 w-5 text-blue-600" />
                {t('importAudio.title.idle')}
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {inProgress
              ? progress?.message || t('importAudio.description.processing')
              : error
              ? t('importAudio.description.error')
              : t('importAudio.description.idle')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* File selection / info */}
          {!inProgress && !error && status !== 'complete' && (
            <>
              {fileInfo ? (
                <div className="bg-gray-50 rounded-lg p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <FileAudio className="h-8 w-8 text-blue-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-gray-900 truncate">{fileInfo.filename}</p>
                      <div className="flex items-center gap-4 text-sm text-gray-500 mt-1">
                        <span className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          {formatDuration(fileInfo.duration_seconds)}
                        </span>
                        <span className="flex items-center gap-1">
                          <HardDrive className="h-3.5 w-3.5" />
                          {formatFileSize(fileInfo.size_bytes, language)}
                        </span>
                        <span className="text-blue-600 font-medium">{fileInfo.format}</span>
                      </div>
                    </div>
                  </div>

                  {/* Editable title */}
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">{t('sidebar.meetingTitle')}</label>
                    <Input
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setTitleModifiedByUser(true);
                      }}
                      placeholder={t('sidebar.meetingTitlePlaceholder')}
                    />
                  </div>

                  <Button variant="outline" size="sm" onClick={handleSelectFile} className="w-full">
                    {t('importAudio.chooseDifferentFile')}
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
                  <FileAudio className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                  <Button onClick={handleSelectFile} disabled={status === 'validating'}>
                    {status === 'validating' ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {t('importAudio.validating')}
                      </>
                    ) : (
                      <>
                        <Upload className="h-4 w-4 mr-2" />
                        {t('importAudio.selectFile')}
                      </>
                    )}
                  </Button>
                  <p className="text-sm text-gray-500 mt-2">MP4, WAV, MP3, FLAC, OGG, MKV, WebM, WMA</p>
                </div>
              )}

              {/* Advanced options (collapsible) */}
              {fileInfo && (
                <div className="border rounded-lg">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full flex items-center justify-between p-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    <span>{t('importAudio.advancedOptions')}</span>
                    {showAdvanced ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  {showAdvanced && (
                    <div className="p-3 pt-0 space-y-4 border-t">
                      {/* Language: transcribe.cpp detects the spoken language
                          itself, so no choice is offered. */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Globe className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{t('importAudio.language.label')}</span>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('importAudio.language.transcribeCppUnsupported')}
                        </p>
                      </div>

                      {/* Model selector */}
                      {availableModels.length > 0 && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">{t('importAudio.model.label')}</span>
                          </div>
                          <Select
                            value={selectedModelKey}
                            onValueChange={setSelectedModelKey}
                            disabled={loadingModels}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder={loadingModels ? t('importAudio.model.loading') : t('importAudio.model.placeholder')} />
                            </SelectTrigger>
                            <SelectContent>
                              {availableModels.map((model) => (
                                <SelectItem
                                  key={`${model.provider}:${model.name}`}
                                  value={`${model.provider}:${model.name}`}
                                >
                                  {model.displayName} ({formatMegabytes(model.size_mb, language)})
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
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
              <p className="text-sm text-muted-foreground text-center">{barMessage}</p>
              {isDiarizing && (
                <p className="text-xs text-muted-foreground text-center">
                  {t('importAudio.diarizationHint')}
                </p>
              )}
            </div>
          )}

          {/* Error display */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          {!inProgress && !error && status !== 'complete' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleStartImport}
                className="bg-blue-600 hover:bg-blue-700"
                disabled={!fileInfo}
              >
                <Upload className="h-4 w-4 mr-2" />
                {t('importAudio.actions.import')}
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
          {status === 'complete' && (
            <Button onClick={goToImportedMeeting} className="bg-blue-600 hover:bg-blue-700">
              <CheckCircle2 className="h-4 w-4 mr-2" />
              {t('importAudio.actions.done')}
            </Button>
          )}
          {error && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.close')}
              </Button>
              <Button onClick={reset} variant="outline">
                {t('importAudio.actions.retry')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
