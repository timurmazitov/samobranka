'use client';

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings, ChevronLeftCircle, ChevronRightCircle, StickyNote, Home, Mic, Square, Search, NotebookPen, Upload } from 'lucide-react';
import { useRouter, usePathname } from 'next/navigation';
import { useSidebar } from './SidebarProvider';
import { meetingRoute } from '@/lib/meeting-route';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { SettingTabs } from '../SettingTabs';
import { TranscriptModelProps } from '@/components/TranscriptSettings';
import { DEFAULT_TRANSCRIBE_CPP_MODEL } from '@/constants/modelDefaults';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';

import { MessageToast } from '../MessageToast';
import Logo from '../Logo';
import FeedbackLink from '../FeedbackLink';
import { ComplianceNotification } from '../ComplianceNotification';
import { Input } from '../ui/input';

const Sidebar: React.FC = () => {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const {
    setCurrentMeeting,
    isCollapsed,
    doodlePath,
    doodleDate,
    toggleCollapse,
    handleRecordingToggle,
    meetings,
    serverAddress
  } = useSidebar();

  // Get recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { openImportDialog } = useImportDialog();
  const [showModelSettings, setShowModelSettings] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    provider: 'ollama',
    model: '',
    whisperModel: '',
    apiKey: null,
    ollamaEndpoint: null
  });
  const [transcriptModelConfig, setTranscriptModelConfig] = useState<TranscriptModelProps>({
    provider: 'transcribeCpp',
    model: DEFAULT_TRANSCRIBE_CPP_MODEL,
  });
  const [settingsSaveSuccess, setSettingsSaveSuccess] = useState<boolean | null>(null);
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    getVersion().then(setAppVersion).catch(console.error);
  }, []);

  // useEffect(() => {
  //   if (settingsSaveSuccess !== null) {
  //     const timer = setTimeout(() => {
  //       setSettingsSaveSuccess(null);
  //     }, 3000);
  //   }
  // }, [settingsSaveSuccess]);


  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchModelConfig = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching model config');
        return;
      }

      try {
        const data = await invoke('api_get_model_config') as any;
        if (data && data.provider !== null) {
          // Fetch API key if not included and provider requires it
          if (data.provider !== 'ollama' && !data.apiKey) {
            try {
              const apiKeyData = await invoke('api_get_api_key', {
                provider: data.provider
              }) as string;
              data.apiKey = apiKeyData;
            } catch (err) {
              console.error('Failed to fetch API key:', err);
            }
          }
          setModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch model config:', error);
      }
    };

    fetchModelConfig();
  }, [serverAddress]);


  useEffect(() => {
    // Note: Don't set hardcoded defaults - let DB be the source of truth
    const fetchTranscriptSettings = async () => {
      // Only make API call if serverAddress is loaded
      if (!serverAddress) {
        console.log('Waiting for server address to load before fetching transcript settings');
        return;
      }

      try {
        const data = await invoke('api_get_transcript_config') as any;
        if (data && data.provider !== null) {
          setTranscriptModelConfig(data);
        }
      } catch (error) {
        console.error('Failed to fetch transcript settings:', error);
      }
    };
    fetchTranscriptSettings();
  }, [serverAddress]);

  // Listen for model config updates from other components
  useEffect(() => {
    const setupListener = async () => {
      const { listen } = await import('@tauri-apps/api/event');
      const unlisten = await listen<ModelConfig>('model-config-updated', (event) => {
        console.log('Sidebar received model-config-updated event:', event.payload);
        setModelConfig(event.payload);
      });

      return unlisten;
    };

    let cleanup: (() => void) | undefined;
    setupListener().then(fn => cleanup = fn);

    return () => {
      cleanup?.();
    };
  }, []);



  // Handle model config save
  const handleSaveModelConfig = async (config: ModelConfig) => {
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey,
        ollamaEndpoint: config.ollamaEndpoint,
      });

      setModelConfig(config);
      console.log('Model config saved successfully');
      setSettingsSaveSuccess(true);

      // Emit event to sync other components
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);
    } catch (error) {
      console.error('Error saving model config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  const handleSaveTranscriptConfig = async (updatedConfig?: TranscriptModelProps) => {
    try {
      const configToSave = updatedConfig || transcriptModelConfig;
      const payload = {
        provider: configToSave.provider,
        model: configToSave.model,
        apiKey: configToSave.apiKey ?? null,
        // Carry the saved compute mode: the backend normalizes an absent
        // value to 'auto', so omitting it here would silently reset the
        // user's transcribe.cpp mode on any sidebar save.
        transcribeBackend: configToSave.transcribeBackend ?? 'auto'
      };
      console.log('Saving transcript config with payload:', payload);

      await invoke('api_save_transcript_config', {
        provider: payload.provider,
        model: payload.model,
        apiKey: payload.apiKey,
        transcribeBackend: payload.transcribeBackend,
      });


      setSettingsSaveSuccess(true);
    } catch (error) {
      console.error('Failed to save transcript config:', error);
      setSettingsSaveSuccess(false);
    }
  };

  // Expose setShowModelSettings to window for Rust tray to call
  useEffect(() => {
    (window as any).openSettings = () => {
      setShowModelSettings(true);
    };

    // Cleanup on unmount
    return () => {
      delete (window as any).openSettings;
    };
  }, []);

  // The notes-mode button (collapsed icon and expanded nav row) reflects and
  // drives the display mode, it does not toggle anything: the notes column
  // cannot be hidden. The mode is active on the notes pages (home, meeting
  // page) and inactive elsewhere (settings, feedback).
  const isMeetingRoute = pathname === '/meeting-details' || pathname?.startsWith('/notes');
  const isNotesModeActive = pathname === '/' || isMeetingRoute;

  const handleNotesModeClick = () => {
    // Already looking at a meeting: the mode button is a no-op there, so a
    // stray click cannot disturb the context.
    if (isMeetingRoute) return;
    // Never navigate away from a live recording.
    if (isRecording) return;
    // The backend list is newest-first; with no meetings there is nothing to
    // open and the column shows its empty state.
    const latest = meetings[0];
    if (!latest) return;
    setCurrentMeeting({ id: latest.id, title: latest.title });
    router.push(meetingRoute(latest.id));
  };

  const renderCollapsedIcons = () => {
    if (!isCollapsed) return null;

    const isHomePage = pathname === '/';
    const isSettingsPage = pathname === '/settings';

    return (
      <TooltipProvider>
        <div className="flex flex-col items-center space-y-4 mt-4">
          <Logo isCollapsed={isCollapsed} doodlePath={doodlePath} doodleDate={doodleDate} />

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => router.push('/')}
                className={`p-2 rounded-lg transition-colors duration-150 ${isHomePage ? 'bg-gray-100' : 'hover:bg-gray-100'
                  }`}
              >
                <Home className="w-5 h-5 text-gray-600" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('nav.home')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleRecordingToggle}
                disabled={isRecording}
                className={`p-2 ${isRecording ? 'bg-red-500 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'} rounded-full transition-colors duration-150 shadow-sm`}
              >
                {isRecording ? (
                  <Square className="w-5 h-5 text-white" />
                ) : (
                  <Mic className="w-5 h-5 text-white" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{isRecording ? t('nav.recordingInProgress') : t('nav.startRecording')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => openImportDialog()}
                className="p-2 rounded-lg transition-colors duration-150 hover:bg-blue-100 bg-blue-50"
              >
                <Upload className="w-5 h-5 text-blue-600" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('nav.importAudio')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleNotesModeClick}
                className={`p-2 rounded-lg transition-colors duration-150 ${isNotesModeActive ? 'bg-gray-100' : 'hover:bg-gray-100'
                  }`}
              >
                <NotebookPen className="w-5 h-5 text-gray-600" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('nav.meetingNotes')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => pathname === '/feedback' ? router.replace('/settings') : router.push('/settings')}
                className={`p-2 rounded-lg transition-colors duration-150 ${isSettingsPage ? 'bg-gray-100' : 'hover:bg-gray-100'
                  }`}
              >
                <Settings className="w-5 h-5 text-gray-600" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{t('nav.settings')}</p>
            </TooltipContent>
          </Tooltip>

          <FeedbackLink isCollapsed={isCollapsed} />
        </div>
      </TooltipProvider>
    );
  };

  return (
    <div className="fixed top-0 left-0 h-screen z-40">
      {/* Floating collapse button */}
      <button
        onClick={toggleCollapse}
        className="absolute -right-6 top-20 z-50 p-1 bg-white hover:bg-gray-100 rounded-full shadow-lg border"
        style={{ transform: 'translateX(50%)' }}
      >
        {isCollapsed ? (
          <ChevronRightCircle className="w-6 h-6" />
        ) : (
          <ChevronLeftCircle className="w-6 h-6" />
        )}
      </button>

      <div
        className={`h-screen bg-white border-r shadow-sm flex flex-col transition-all duration-300 ${isCollapsed ? 'w-16' : 'w-64'
          }`}
      >
        {/*  Header with traffic light spacing */}
        <div className="flex-shrink-0 h-22 flex items-center">

          {/* Title container */}



          <div className="flex-1">
            {!isCollapsed && (
              <div className="p-3">
                {/* <span className="text-lg text-center border rounded-full bg-blue-50 border-white font-semibold text-gray-700 mb-2 block items-center">
                  <span>Samobranka</span>
                </span> */}
                <Logo isCollapsed={isCollapsed} />
              </div>
            )}
          </div>
        </div>

        {/* Main content - scrollable area */}
        <div className="flex-1 flex flex-col min-h-0">
          {/* Fixed navigation items */}
          <div className="flex-shrink-0">
            {!isCollapsed && (
              <>
                <div
                  onClick={() => router.push('/')}
                  className="p-3  text-lg font-semibold items-center hover:bg-gray-100 h-10   flex mx-3 mt-3 rounded-lg cursor-pointer"
                >
                  <Home className="w-4 h-4 mr-2" />
                  <span>{t('nav.home')}</span>
                </div>
                <div
                  onClick={handleNotesModeClick}
                  className={`p-3  text-lg font-semibold items-center h-10   flex mx-3 mt-3 rounded-lg cursor-pointer ${isNotesModeActive ? 'bg-gray-100' : 'hover:bg-gray-100'
                    }`}
                >
                  <NotebookPen className="w-4 h-4 mr-2" />
                  <span>{t('nav.meetingNotes')}</span>
                </div>
              </>
            )}
          </div>

          {/* Content area */}
          <div className="flex-1 flex flex-col min-h-0">
            {renderCollapsedIcons()}
          </div>
        </div>

        {/* Footer */}
        {!isCollapsed && (

          <div className="flex-shrink-0 p-2 border-t border-gray-100">
            <button
              onClick={handleRecordingToggle}
              disabled={isRecording}
              className={`w-full flex items-center justify-center px-3 py-2 text-sm font-medium text-white ${isRecording ? 'bg-red-300 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600'} rounded-lg transition-colors shadow-sm`}
            >
              {isRecording ? (
                <>
                  <Square className="w-4 h-4 mr-2" />
                  <span>{t('nav.recordingInProgress')}</span>
                </>
              ) : (
                <>
                  <Mic className="w-4 h-4 mr-2" />
                  <span>{t('nav.startRecording')}</span>
                </>
              )}
            </button>

            <button
              onClick={() => openImportDialog()}
              className="w-full flex items-center justify-center px-3 py-2 mt-1 text-sm font-medium text-gray-700 bg-blue-100 hover:bg-blue-200 rounded-lg transition-colors shadow-sm"
            >
              <Upload className="w-4 h-4 mr-2" />
              <span>{t('nav.importAudio')}</span>
            </button>

            <button
              onClick={() => pathname === '/feedback' ? router.replace('/settings') : router.push('/settings')}
              className="w-full flex items-center justify-center px-3 py-1.5 mt-1 mb-1 text-sm font-medium text-gray-700 bg-gray-200 hover:bg-gray-300 rounded-lg transition-colors shadow-sm"
            >
              <Settings className="w-4 h-4 mr-2" />
              <span>{t('nav.settings')}</span>
            </button>
            <FeedbackLink isCollapsed={isCollapsed} />
            <div className="w-full flex items-center justify-center px-3 py-1 text-xs text-gray-400">
              {appVersion && `v${appVersion}`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
