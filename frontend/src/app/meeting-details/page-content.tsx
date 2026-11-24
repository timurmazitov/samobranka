"use client";
import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { MeetingSpeaker, MeetingSummary, SummaryProcessResponse } from '@/types';
import { useSidebar } from '@/components/Sidebar/SidebarProvider';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { TranscriptPanel } from '@/components/MeetingDetails/TranscriptPanel';
import { SummaryPanel } from '@/components/MeetingDetails/SummaryPanel';
import { MeetingDetailsSplitView, type MeetingDetailsTab } from '@/components/MeetingDetails/MeetingDetailsSplitView';
import { FindReplacePanel } from '@/components/MeetingDetails/FindReplacePanel';
import { ModelConfig } from '@/components/ModelSettingsModal';

// Custom hooks
import { useMeetingData } from '@/hooks/meeting-details/useMeetingData';
import { useSummaryGeneration } from '@/hooks/meeting-details/useSummaryGeneration';
import { useTemplates } from '@/hooks/meeting-details/useTemplates';
import { useCopyOperations } from '@/hooks/meeting-details/useCopyOperations';
import { useMeetingOperations } from '@/hooks/meeting-details/useMeetingOperations';
import { useTranscriptEditSummaryHint } from '@/hooks/meeting-details/useTranscriptEditSummaryHint';
import { useFindReplace } from '@/hooks/meeting-details/useFindReplace';
import { useDiarizationPassRunning } from '@/hooks/useDiarizationPassRunning';
import { useConfig } from '@/contexts/ConfigContext';

export default function PageContent({
  meeting,
  summaryData,
  initialSummary,
  shouldAutoGenerate = false,
  onAutoGenerateComplete,
  onMeetingUpdated,
  onRefetchTranscripts,
  // Pagination props for efficient transcript loading
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  onLoadAllPages,
  meetingSpeakers,
  onSpeakerChanged,
  onTextEdited,
}: {
  meeting: any;
  summaryData: MeetingSummary | null;
  initialSummary: SummaryProcessResponse | null;
  shouldAutoGenerate?: boolean;
  onAutoGenerateComplete?: () => void;
  onMeetingUpdated?: () => Promise<void>;
  onRefetchTranscripts?: () => Promise<void>;
  // Pagination props
  segments?: any[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;
  /** Drain every remaining transcript page (find panel's first-open load). */
  onLoadAllPages?: () => void | Promise<void>;
  // Speakers of this meeting, used by the per-row dropdown
  meetingSpeakers?: MeetingSpeaker[];
  onSpeakerChanged?: (transcriptId: string, label: string | null) => void | Promise<void>;
  /** A row's saved text edit, applied to the pagination state by the page. */
  onTextEdited?: (transcriptId: string, text: string) => void | Promise<void>;
}) {
  console.log('📄 PAGE CONTENT: Initializing with data:', {
    meetingId: meeting.id,
    summaryDataKeys: summaryData ? Object.keys(summaryData) : null,
    transcriptsCount: meeting.transcripts?.length
  });

  // State
  const [customPrompt, setCustomPrompt] = useState<string>('');
  const isRecording = false;
  // The same shared pass store the speakers panel gates its buttons on: while
  // a pass runs for this meeting, inline text editing closes too, so the two
  // surfaces block and unblock together.
  const isDiarizing = useDiarizationPassRunning(meeting?.id);
  const [activeTab, setActiveTab] = useState<MeetingDetailsTab>('transcript');

  // Ref to store the modal open function from SummaryGeneratorButtonGroup
  const openModelSettingsRef = useRef<(() => void) | null>(null);
  const autoSwitchedSummaryMeetingIdsRef = useRef(new Set<string>());
  const manuallySelectedTabMeetingIdsRef = useRef(new Set<string>());
  const autoGenerationStartedMeetingIdRef = useRef<string | null>(null);

  // Sidebar context
  const { serverAddress, isCollapsed } = useSidebar();

  // Get model config from ConfigContext
  const { modelConfig, setModelConfig, isModelConfigLoading } = useConfig();
  const { t } = useTranslation();

  // Custom hooks
  const meetingData = useMeetingData({ meeting, summaryData, onMeetingUpdated });
  const templates = useTemplates();

  // Callback to register the modal open function
  const handleRegisterModalOpen = (openFn: () => void) => {
    console.log('📝 Registering modal open function in PageContent');
    openModelSettingsRef.current = openFn;
  };

  // Callback to trigger modal open (called from error handler)
  const handleOpenModelSettings = () => {
    console.log('🔔 Opening model settings from PageContent');
    if (openModelSettingsRef.current) {
      openModelSettingsRef.current();
    } else {
      console.warn('⚠️ Modal open function not yet registered');
    }
  };

  // Save model config to backend database and sync via event
  const handleSaveModelConfig = async (config?: ModelConfig) => {
    if (!config) return;
    try {
      await invoke('api_save_model_config', {
        provider: config.provider,
        model: config.model,
        whisperModel: config.whisperModel,
        apiKey: config.apiKey ?? null,
        ollamaEndpoint: config.ollamaEndpoint ?? null,
      });

      // Emit event so ConfigContext and other listeners stay in sync
      const { emit } = await import('@tauri-apps/api/event');
      await emit('model-config-updated', config);

      toast.success(t('settingsSummary.modelSettings.saved'));
    } catch (error) {
      console.error('Failed to save model config:', error);
      toast.error(t('settingsSummary.modelSettings.saveFailed'));
    }
  };

  const summaryGeneration = useSummaryGeneration({
    initialSummary,
    meeting,
    transcripts: meetingData.transcripts,
    modelConfig: modelConfig,
    isModelConfigLoading,
    selectedTemplate: templates.selectedTemplate,
    onMeetingUpdated,
    updateMeetingTitle: meetingData.updateMeetingTitle,
    setAiSummary: meetingData.setAiSummary,
    onOpenModelSettings: handleOpenModelSettings,
  });

  // A saved row edit makes an existing summary stale (summaries read the
  // transcript text from the database), so offer the existing regenerate
  // action through a single hint toast — never automatically.
  const notifySummaryStale = useTranscriptEditSummaryHint({
    hasCompletedSummary: summaryGeneration.summaryStatus === 'completed',
    onRegenerate: summaryGeneration.handleRegenerateSummary,
  });
  const handleTranscriptTextEdited = useCallback(async (transcriptId: string, text: string) => {
    await onTextEdited?.(transcriptId, text);
    notifySummaryStale();
  }, [onTextEdited, notifySummaryStale]);

  const copyOperations = useCopyOperations({
    meeting,
    transcripts: meetingData.transcripts,
    meetingTitle: meetingData.meetingTitle,
    aiSummary: meetingData.aiSummary,
    blockNoteSummaryRef: meetingData.blockNoteSummaryRef,
  });

  const meetingOperations = useMeetingOperations({
    meeting,
  });

  // The find & replace panel's state: query, toggles, the combined match
  // list over the loaded segments, and the active position. The first open
  // drains every segment page through the pagination hook so matches cover
  // the whole meeting.
  const findReplace = useFindReplace({
    segments: segments ?? [],
    loadAllPages: onLoadAllPages,
  });
  const { openPanel, closePanel } = findReplace;

  // Page hotkeys — the meeting page's only document keydown listener. Ctrl/Cmd
  // +F and +H are intercepted with preventDefault, which also suppresses the
  // webview's native find; +H focuses the replace field. Esc closes. No
  // hotkey library: the legacy summary editor's Ctrl handler is the precedent.
  useEffect(() => {
    // Headless render environments (react-test-renderer) have no document,
    // and a polluted test process can hold a partial stub: register only on
    // a real DOM. A real webview always has one.
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Physical key codes too: on a Cyrillic layout Ctrl+Ф arrives as key
      // 'а', and the panel must still open.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (event.code === 'KeyF' || event.key === 'f' || event.key === 'F') {
          event.preventDefault();
          openPanel({ focus: 'search' });
        } else if (event.code === 'KeyH' || event.key === 'h' || event.key === 'H') {
          event.preventDefault();
          openPanel({ focus: 'replace' });
        }
      } else if (event.key === 'Escape' && !event.defaultPrevented) {
        // A row editor's Escape cancels the edit and marks the event handled;
        // only an unclaimed Escape closes the panel.
        closePanel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openPanel, closePanel]);

  useEffect(() => {
    if (
      (meetingData.aiSummary || summaryGeneration.summaryStatus === 'completed')
      && !autoSwitchedSummaryMeetingIdsRef.current.has(meeting.id)
      && !manuallySelectedTabMeetingIdsRef.current.has(meeting.id)
    ) {
      autoSwitchedSummaryMeetingIdsRef.current.add(meeting.id);
      setActiveTab('summary');
    }
  }, [meeting.id, meetingData.aiSummary, summaryGeneration.summaryStatus]);

  // Auto-generate only after the model configuration has settled.
  useEffect(() => {
    if (
      !shouldAutoGenerate
      || summaryGeneration.summaryStatus !== 'idle'
      || isModelConfigLoading
      || meetingData.transcripts.length === 0
      || autoGenerationStartedMeetingIdRef.current === meeting.id
    ) {
      return;
    }

    autoGenerationStartedMeetingIdRef.current = meeting.id;
    console.log(`🤖 Auto-generating summary with ${modelConfig.provider}/${modelConfig.model}...`);
    onAutoGenerateComplete?.();
    void summaryGeneration.handleGenerateSummary('');
  }, [
    shouldAutoGenerate,
    meeting.id,
    meetingData.transcripts.length,
    isModelConfigLoading,
    modelConfig.provider,
    modelConfig.model,
    summaryGeneration.handleGenerateSummary,
    summaryGeneration.summaryStatus,
    onAutoGenerateComplete,
  ]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="flex flex-col h-screen min-w-0 bg-gray-50"
    >
      <div className="flex flex-1 min-w-0 overflow-hidden">
        <MeetingDetailsSplitView
          activeTab={activeTab}
          onTabChange={(tab) => {
            manuallySelectedTabMeetingIdsRef.current.add(meeting.id);
            setActiveTab(tab);
          }}
          transcript={
            <TranscriptPanel
              transcripts={meetingData.transcripts}
              customPrompt={customPrompt}
              onPromptChange={setCustomPrompt}
              onCopyTranscript={copyOperations.handleCopyTranscript}
              onExportTranscript={copyOperations.handleExportTranscript}
              onOpenMeetingFolder={meetingOperations.handleOpenMeetingFolder}
              isRecording={isRecording}
              disableAutoScroll={true}
              usePagination={true}
              segments={segments}
              hasMore={hasMore}
              isLoadingMore={isLoadingMore}
              totalCount={totalCount}
              loadedCount={loadedCount}
              onLoadMore={onLoadMore}
              meetingId={meeting.id}
              meetingFolderPath={meeting.folder_path}
              onRefetchTranscripts={onRefetchTranscripts}
              meetingSpeakers={meetingSpeakers}
              onSpeakerChanged={onSpeakerChanged}
              onTextEdited={handleTranscriptTextEdited}
              isDiarizing={isDiarizing}
              onOpenFind={() => openPanel({ focus: 'search' })}
              findOpen={findReplace.open}
              findMatches={findReplace.matches}
              findActiveIndex={findReplace.activeIndex}
            />
          }
          summary={
            <SummaryPanel
              meeting={meeting}
              meetingDate={meeting.recorded_at}
              meetingTitle={meetingData.meetingTitle}
              summaryRef={meetingData.blockNoteSummaryRef}
              isSaving={meetingData.isSaving}
              isSummaryDirty={meetingData.isSummaryDirty}
              onSaveAll={meetingData.saveAllChanges}
              onCopySummary={copyOperations.handleCopySummary}
              onExportSummary={copyOperations.handleExportSummary}
              aiSummary={meetingData.aiSummary}
              summaryStatus={summaryGeneration.summaryStatus}
              transcripts={meetingData.transcripts}
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              onSaveModelConfig={handleSaveModelConfig}
              onGenerateSummary={summaryGeneration.handleGenerateSummary}
              onStopGeneration={summaryGeneration.handleStopGeneration}
              customPrompt={customPrompt}
              onSaveSummary={meetingData.handleSaveSummary}
              onSummaryChange={meetingData.handleSummaryChange}
              onDirtyChange={meetingData.setIsSummaryDirty}
              summaryError={summaryGeneration.summaryError}
              onRegenerateSummary={summaryGeneration.handleRegenerateSummary}
              getSummaryStatusMessage={summaryGeneration.getSummaryStatusMessage}
              availableTemplates={templates.availableTemplates}
              selectedTemplate={templates.selectedTemplate}
              onTemplateSelect={templates.handleTemplateSelection}
              isModelConfigLoading={isModelConfigLoading}
              onOpenModelSettings={handleRegisterModalOpen}
            />
          }
        />
      </div>

      {/* The find & replace card: fixed, non-modal, sidebar-compensated. */}
      <FindReplacePanel
        open={findReplace.open}
        query={findReplace.query}
        onQueryChange={findReplace.setQuery}
        caseSensitive={findReplace.caseSensitive}
        onCaseSensitiveChange={findReplace.setCaseSensitive}
        wholeWord={findReplace.wholeWord}
        onWholeWordChange={findReplace.setWholeWord}
        current={findReplace.current}
        total={findReplace.total}
        hasQuery={findReplace.hasQuery}
        onPrevious={findReplace.goPrev}
        onNext={findReplace.goNext}
        onClose={closePanel}
        focusTarget={findReplace.focusTarget}
        focusNonce={findReplace.focusNonce}
        sidebarCollapsed={isCollapsed}
      />
    </motion.div>
  );
}
