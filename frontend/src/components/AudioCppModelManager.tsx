import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import {
  downloadProgress,
  formatModelSize,
  isAvailableStatus,
  isDownloadingStatus,
  modelDescription,
  taskLabel,
  type AudioCppDownloadCompleteEvent,
  type AudioCppDownloadErrorEvent,
  type AudioCppDownloadProgressEvent,
  type AudioCppModelClient,
  type AudioCppModelInfo,
  type AudioCppModelStatus,
} from '../lib/audiocpp';

/**
 * Model manager for the audio.cpp diarization model (Nemotron).
 *
 * Lists the catalogued diarization model with its purpose and size, and lets
 * the user download, cancel and delete it. Downloads report progress and can
 * be cancelled; the list is re-read from the native manager so persisted
 * state (installed / missing) survives restarts.
 *
 * Diarization is never selectable: a diarization model cannot transcribe, so
 * it is installed as an add-on over whichever engine produced the transcript.
 * The transcription (asr) mode was removed with the transcribe.cpp
 * consolidation; only diar entries of the catalog render.
 */
export interface AudioCppModelManagerProps {
  className?: string;
  /**
   * Native client. Defaults to the Tauri-backed client, loaded on demand so
   * this module (and its tests) do not pull in the Tauri bridge.
   */
  client?: AudioCppModelClient;
}

export function AudioCppModelManager({
  className = '',
  client: injectedClient,
}: AudioCppModelManagerProps) {
  const { t } = useTranslation();
  const [client, setClient] = useState<AudioCppModelClient | undefined>(injectedClient);
  const [models, setModels] = useState<AudioCppModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [listenersReady, setListenersReady] = useState(false);
  const [cancellingModels, setCancellingModels] = useState<Set<string>>(new Set());
  /** Native runtime report; `null` until asked or when the command failed. */
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  // Progress updates arrive much faster than React should re-render.
  const progressThrottleRef = useRef<Map<string, { progress: number; timestamp: number }>>(new Map());
  const latestStatusByModelRef = useRef<Map<string, AudioCppModelStatus>>(new Map());
  const modelsRef = useRef<AudioCppModelInfo[]>([]);

  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  const nameOf = useCallback(
    (modelName: string) => displayName(modelName, modelsRef.current),
    [],
  );

  /**
   * Whether this manager owns the model a native event is about.
   *
   * The catalog is diarization-only now, but the event payload is a bare
   * model name from the native side; a foreign model's events (an older
   * catalog state, a concurrent manager) must not be announced here.
   */
  const ownsModel = useCallback(
    (modelName: string) =>
      modelsRef.current.find(model => model.name === modelName)?.task === 'diar',
    [],
  );

  const clearCancellingModel = useCallback((modelName: string) => {
    setCancellingModels(prev => {
      const next = new Set(prev);
      next.delete(modelName);
      return next;
    });
  }, []);

  // Resolve the default client lazily; the Tauri bridge is only needed once
  // the model manager is actually shown.
  useEffect(() => {
    if (injectedClient) {
      setClient(injectedClient);
      return;
    }
    let disposed = false;
    void import('../lib/audiocppClient').then(module => {
      if (!disposed) setClient(module.audioCppClient);
    });
    return () => {
      disposed = true;
    };
  }, [injectedClient]);

  const refreshModels = useCallback(async () => {
    if (!client) return;
    const list = await client.getAvailableModels();
    setModels(list.map(model => ({
      ...model,
      status: latestStatusByModelRef.current.get(model.name) ?? model.status,
    })));
  }, [client]);

  // Event listeners: register before the first model fetch so no progress is
  // missed while the catalog is loading.
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    let unlisteners: Array<() => void> = [];

    const setupListeners = async () => {
      const registrations = await Promise.allSettled([
        client.listenProgress(event => {
          const { modelName, progress, status } = event;
          if (!ownsModel(modelName)) return;

          if (status === 'cancelled') {
            latestStatusByModelRef.current.set(modelName, 'Missing');
            progressThrottleRef.current.delete(modelName);
            clearCancellingModel(modelName);
            setModels(prev => prev.map(model =>
              model.name === modelName ? { ...model, status: 'Missing' as AudioCppModelStatus } : model
            ));
            toast.info(t('models.common.downloadCancelled', { name: nameOf(modelName) }), { duration: 3000 });
            return;
          }

          const modelStatus: AudioCppModelStatus = status === 'completed'
            ? 'Available'
            : { Downloading: { progress } };
          latestStatusByModelRef.current.set(modelName, modelStatus);

          const now = Date.now();
          const throttle = progressThrottleRef.current.get(modelName);
          const shouldUpdate = !throttle
            || now - throttle.timestamp > 300
            || Math.abs(progress - throttle.progress) >= 5;

          if (shouldUpdate) {
            progressThrottleRef.current.set(modelName, { progress, timestamp: now });
            setModels(prev => prev.map(model =>
              model.name === modelName ? { ...model, status: modelStatus } : model
            ));
          }
        }),
        client.listenComplete(event => {
          const { modelName } = event;
          if (!ownsModel(modelName)) return;
          latestStatusByModelRef.current.set(modelName, 'Available');
          progressThrottleRef.current.delete(modelName);
          clearCancellingModel(modelName);

          setModels(prev => prev.map(model =>
            model.name === modelName ? { ...model, status: 'Available' as AudioCppModelStatus } : model
          ));

          toast.success(t('models.common.modelReady', { name: nameOf(modelName) }), {
            description: t('models.common.downloadedAndReady'),
            duration: 4000,
          });
        }),
        client.listenError(event => {
          const { modelName, error } = event;
          if (!ownsModel(modelName)) return;
          latestStatusByModelRef.current.set(modelName, { Error: error });
          progressThrottleRef.current.delete(modelName);
          clearCancellingModel(modelName);

          setModels(prev => prev.map(model =>
            model.name === modelName ? { ...model, status: { Error: error } as AudioCppModelStatus } : model
          ));

          toast.error(t('models.common.downloadFailedFor', { name: nameOf(modelName) }), {
            description: error,
            duration: 6000,
          });
        }),
      ]);

      const registered = registrations.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : []
      );
      const failed = registrations.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );

      if (disposed || failed) {
        registered.forEach(unlisten => unlisten());
        if (!disposed && failed) {
          const reason = failed.reason;
          setError(reason instanceof Error ? reason.message : t('models.common.listeningFailed'));
          setLoading(false);
        }
        return;
      }

      unlisteners = registered;
      setListenersReady(true);
    };

    void setupListeners();

    return () => {
      disposed = true;
      unlisteners.forEach(unlisten => unlisten());
    };
    // Listeners are registered once; callbacks read models through modelsRef.
  }, [clearCancellingModel, nameOf, ownsModel, client]);

  // Initialize the native manager and load the catalog once listeners exist.
  useEffect(() => {
    if (!client || initialized || !listenersReady) return;
    let disposed = false;

    const initialize = async () => {
      try {
        setLoading(true);
        await client.init();
        const list = await client.getAvailableModels();
        if (disposed) return;
        setModels(list);
        setInitialized(true);
      } catch (err) {
        if (disposed) return;
        console.error('Failed to initialize audio.cpp model manager:', err);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!disposed) setLoading(false);
      }
    };

    void initialize();
    return () => {
      disposed = true;
    };
  }, [initialized, listenersReady, client]);

  // The diarization section explains an unusable native runtime up front. The
  // model card stays downloadable: the warning explains why a pass would not
  // run now, and the model can be prepared ahead of the library.
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    void client.getDiagnostics()
      .then(report => {
        if (disposed) return;
        setRuntimeError(report.available ? null : report.error ?? t('models.audioCpp.nativeLibraryUnavailable'));
      })
      .catch(err => {
        // Diagnostics are advisory: an unanswered report must not turn into a
        // crash or a false claim that the engine is missing.
        console.error('Failed to read audio.cpp diagnostics:', err);
      });
    return () => {
      disposed = true;
    };
  }, [client]);

  const downloadModel = async (modelName: string) => {
    if (!client || cancellingModels.has(modelName)) return;
    clearCancellingModel(modelName);

    setModels(prev => prev.map(model =>
      model.name === modelName
        ? { ...model, status: { Downloading: { progress: 0 } } as AudioCppModelStatus }
        : model
    ));

    toast.info(t('models.common.downloadingToast', { name: nameOf(modelName) }), {
      description: t('models.common.mayTakeMinutes'),
      duration: 5000,
    });

    try {
      await client.downloadModel(modelName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Keep the failure visible in the card so the user can retry, matching
      // the transcribe.cpp manager.
      latestStatusByModelRef.current.set(modelName, { Error: message });
      setModels(prev => prev.map(model =>
        model.name === modelName ? { ...model, status: { Error: message } } : model
      ));
      toast.error(t('models.common.downloadFailedFor', { name: nameOf(modelName) }), {
        description: message,
        duration: 6000,
      });
    }
  };

  const cancelDownload = async (modelName: string) => {
    if (!client) return;
    setCancellingModels(prev => new Set([...prev, modelName]));
    try {
      const outcome = await client.cancelDownload(modelName);
      if (outcome === 'pending') {
        toast.info(t('models.common.cancellingFor', { name: nameOf(modelName) }), {
          description: t('models.common.cancellationPending'),
          duration: 4000,
        });
      }
    } catch (err) {
      clearCancellingModel(modelName);
      console.error('Failed to cancel audio.cpp model download:', err);
      toast.error(t('models.common.failedToCancelDownload'), { description: String(err), duration: 4000 });
    }
  };

  const deleteModel = async (modelName: string) => {
    if (!client) return;
    const name = nameOf(modelName);
    try {
      await client.deleteModel(modelName);
      latestStatusByModelRef.current.delete(modelName);
      progressThrottleRef.current.delete(modelName);
      await refreshModels();
      toast.success(t('models.common.modelDeleted', { name }), {
        description: t('models.common.modelRemoved'),
        duration: 3000,
      });
    } catch (err) {
      console.error('Failed to delete audio.cpp model:', err);
      toast.error(t('models.common.failedToDelete', { name }), { description: String(err), duration: 4000 });
    }
  };

  // Only diarization entries render: the transcribe.cpp engine owns
  // transcription, and a diarization model can never be selected as one.
  const visibleModels = models.filter(model => model.task === 'diar');

  if (loading) {
    return (
      <div className={`space-y-3 ${className}`} data-testid="audiocpp-model-manager-loading">
        <div className="animate-pulse space-y-3">
          <div className="h-20 bg-gray-100 rounded-lg"></div>
          <div className="h-20 bg-gray-100 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`bg-red-50 border border-red-200 rounded-lg p-4 ${className}`}>
        <p className="text-sm text-red-800">{t('models.audioCpp.failedToLoadModels')}</p>
        <p className="text-xs text-red-600 mt-1">{error}</p>
      </div>
    );
  }

  return (
    <div className={`space-y-3 ${className}`} data-testid="audiocpp-model-manager">
      {runtimeError && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-3"
          data-testid="audiocpp-runtime-warning"
          title={runtimeError}
        >
          <p className="text-sm font-medium text-amber-900">
            {t('models.audioCpp.runtimeUnavailable')}
          </p>
          <p className="mt-1 text-xs text-amber-700">
            {t('models.audioCpp.runtimeUnavailableDescription')}
          </p>
        </div>
      )}

      {visibleModels.map(model => (
        <AudioCppModelCard
          key={model.name}
          model={model}
          isCancelling={cancellingModels.has(model.name)}
          onDownload={() => downloadModel(model.name)}
          onCancel={() => cancelDownload(model.name)}
          onDelete={() => deleteModel(model.name)}
        />
      ))}

      <button
        type="button"
        onClick={() => { void client?.openModelsFolder(); }}
        className="text-xs text-gray-500 hover:text-gray-700 underline"
      >
        {t('models.audioCpp.openModelsFolder')}
      </button>
    </div>
  );
}

function displayName(modelName: string, models: AudioCppModelInfo[]): string {
  return models.find(model => model.name === modelName)?.display_name ?? modelName;
}

interface AudioCppModelCardProps {
  model: AudioCppModelInfo;
  isCancelling: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}

function AudioCppModelCard({
  model,
  isCancelling,
  onDownload,
  onCancel,
  onDelete,
}: AudioCppModelCardProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const available = isAvailableStatus(model.status);
  const downloading = isDownloadingStatus(model.status);
  const progress = downloadProgress(model.status) ?? 0;
  const isCorrupted = typeof model.status === 'object'
    && model.status !== null
    && 'Corrupted' in model.status;
  const isError = typeof model.status === 'object' && model.status !== null && 'Error' in model.status;

  const taskBadge = taskLabel(model.task);

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`relative rounded-lg border-2 bg-white transition-all ${
        available
          ? 'border-green-200'
          : 'border-gray-200'
      }`}
      data-testid={`audiocpp-model-${model.name}`}
      data-model-family={model.family}
      data-model-task={model.task}
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h3 className="font-semibold text-gray-900">{model.display_name}</h3>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-purple-100 text-purple-800">
                {taskBadge}
              </span>
              <span className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full font-medium">
                {model.quantization}
              </span>
              <span className="text-xs text-gray-500">{formatModelSize(model.size_mb)}</span>
            </div>
            <p className="text-sm text-gray-600">
              {modelDescription(model.family, model.description)}
            </p>
            <p className="text-xs text-gray-400 mt-1">{model.family}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {available && !isCancelling && (
              <>
                <div className="flex items-center gap-1.5 text-green-600">
                  <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                  <span className="text-xs font-medium">{t('models.common.ready')}</span>
                </div>
                {isHovered && (
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); onDelete(); }}
                      className="text-gray-400 hover:text-red-600 transition-colors p-1"
                      title={t('models.common.deleteModelTitle')}
                      aria-label={t('models.common.deleteModelAria', { name: model.display_name })}
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
              </>
            )}

            {!available && !downloading && !isCancelling && !isCorrupted && (
              <button
                type="button"
                onClick={(event) => { event.stopPropagation(); onDownload(); }}
                className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                {isError ? t('models.common.retry') : t('models.common.download')}
              </button>
            )}

            {isCorrupted && !isCancelling && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onDelete(); }}
                  className="bg-orange-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-orange-700 transition-colors"
                >
                  {t('common.delete')}
                </button>
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onDownload(); }}
                  className="bg-blue-600 text-white px-3 py-1.5 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  {t('models.common.reDownload')}
                </button>
              </div>
            )}
          </div>
        </div>

        {(downloading || isCancelling) && (
          <div className="mt-3 pt-3 border-t border-gray-200">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-blue-600">
                  {isCancelling ? t('models.common.cancelling') : t('models.common.downloading')}
                </span>
                {!isCancelling && (
                  <span className="text-sm font-semibold text-blue-600">{Math.round(progress)}%</span>
                )}
              </div>
              {isCancelling ? (
                <span className="text-xs text-gray-500 font-medium px-2 py-1">{t('models.common.cancellationRequested')}</span>
              ) : (
                <button
                  type="button"
                  onClick={(event) => { event.stopPropagation(); onCancel(); }}
                  className="text-xs text-gray-600 hover:text-red-600 font-medium transition-colors px-2 py-1 rounded hover:bg-red-50"
                  title={t('models.common.cancelDownloadTitle')}
                >
                  {t('common.cancel')}
                </button>
              )}
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-blue-600 rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {formatModelSize(model.size_mb * progress / 100)} / {formatModelSize(model.size_mb)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
