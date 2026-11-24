"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
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
import { useTranscriptSelection } from '@/hooks/meeting-details/useTranscriptSelection';
import { useFindReplace, type SummaryBlock } from '@/hooks/meeting-details/useFindReplace';
import type { SummaryReplaceEdit } from '@/lib/summary-find-replace';
import { useDiarizationPassRunning } from '@/hooks/useDiarizationPassRunning';
import { useRetranscriptionRunning } from '@/hooks/useRetranscriptionRunning';
import { useConfig } from '@/contexts/ConfigContext';

// The selection Delete key (ticket 03) must never eat a keystroke meant for
// typing: the inline row editor, the find panel's inputs and the prompt
// textarea all live inside this page's DOM. Like the row editor's Escape
// claim, a focused editable target answers for itself.
function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as {
    tagName?: string;
    type?: string;
    isContentEditable?: boolean;
  } | null;
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // A checkbox the user just clicked is not a typing field (and Delete is
    // inert on it anyway); every text-ish input type is.
    const nonTextTypes = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
    return !nonTextTypes.includes(element.type ?? 'text');
  }
  return false;
}

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
  onSegmentDeleted,
  onSegmentsBulkDeleted,
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
  /** A row's segment delete, applied optimistically by the pagination hook. */
  onSegmentDeleted?: (transcriptId: string) => void | Promise<void>;
  /**
   * Bulk delete of the selected segments (ticket 02): the page's owner wires
   * this to the pagination hook's batch delete (with the current-window
   * refetch) plus the speaker reload. The view owns the confirmation and the
   * failure toast; the error rethrows so neither claims success.
   */
  onSegmentsBulkDeleted?: (transcriptIds: string[]) => void | Promise<void>;
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
  // The retranscription rewrites the whole transcript from the audio: the
  // hover trash closes while it runs, exactly like editing closes for the
  // diarization pass (spec: delete gates = edit gates plus retranscription).
  const isRetranscribing = useRetranscriptionRunning(meeting?.id);
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

  // A delete removes rows the summary was built from, so it makes an existing
  // summary stale exactly like an edit does. The hint fires only after the
  // delete resolves: a rejection propagates to the row (its toast) and skips
  // the hint. The bulk toolbar (ticket 02/05) reuses this same callback chain
  // so the hint stays single and id-deduped.
  const handleSegmentDeleted = useCallback(async (transcriptId: string) => {
    await onSegmentDeleted?.(transcriptId);
    notifySummaryStale();
  }, [onSegmentDeleted, notifySummaryStale]);

  // Bulk selection mode (ticket 02). The page owns the ephemeral id set —
  // like it owns the find panel's state — because the view is shared with
  // the live recording page. Ticket 04 wires both exclusivity directions
  // through these callbacks: `exitSelection` when Find opens (including the
  // Ctrl+F/H hotkey path) and when the pencil opens an editor.
  const selection = useTranscriptSelection(meeting?.id);
  const {
    exitSelection,
    setSelectedIds: setSelectedSegments,
    toggleAllVisible: toggleAllVisibleSegments,
    rangeSelectTo: rangeSelectToSegment,
  } = selection;
  // After a successful batch the deleted ids are gone, so the selection
  // empties while the mode stays open for further cleaning; a rejection
  // keeps the selection intact so the user can retry after the rollback.
  // The stale-summary hint for bulk delete is ticket 05's call to add here.
  const handleSegmentsBulkDeleted = useCallback(async (transcriptIds: string[]) => {
    await onSegmentsBulkDeleted?.(transcriptIds);
    setSelectedSegments([]);
  }, [onSegmentsBulkDeleted, setSelectedSegments]);

  // Ticket 03's assistants. «Выделить всё видимое» is a toggle over the
  // LOADED segments (the second press clears); by-speaker filters the same
  // loaded window by the diarization label — never the panel's whole-meeting
  // segment_count, which would inflate «Удалить (N)» past what the batch
  // command can actually delete. Loaded order is the pagination hook's
  // audio-time order, so Shift ranges follow what the user sees.
  const loadedSegments = useMemo(() => segments ?? [], [segments]);
  const loadedIds = useMemo(
    () => loadedSegments.map(segment => segment.id as string),
    [loadedSegments],
  );
  const handleSelectAllVisible = useCallback(() => {
    toggleAllVisibleSegments(loadedIds);
  }, [toggleAllVisibleSegments, loadedIds]);
  const handleSelectBySpeaker = useCallback((label: string) => {
    setSelectedSegments(
      loadedSegments
        .filter(segment => segment.speaker === label)
        .map(segment => segment.id as string),
    );
  }, [setSelectedSegments, loadedSegments]);
  const handleRowRangeSelect = useCallback((transcriptId: string) => {
    rangeSelectToSegment(transcriptId, loadedIds);
  }, [rangeSelectToSegment, loadedIds]);

  // Delete-key seam (ticket 03): the page's single keydown listener cannot
  // own the confirmation — the N>1 dialog and the failure toast live in the
  // view with the «Удалить (N)» button. A nonce instead asks the view to
  // press that very button (FindReplacePanel's focusNonce pattern), so the
  // keyboard and the click can never diverge.
  const [bulkDeleteNonce, setBulkDeleteNonce] = useState(0);

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

  // The summary's searchable blocks, reported up by the summary surface
  // (BlockNote / markdown / legacy) whenever its editor content changes. The
  // hook folds them into the combined list after the transcript segments, so
  // ↑/↓ walk one list across both sources.
  const [summaryBlocks, setSummaryBlocks] = useState<SummaryBlock[]>([]);

  // The find & replace panel's state: query, toggles, the combined match
  // list over the loaded segments and the summary, and the active position.
  // The first open drains every segment page through the pagination hook so
  // matches cover the whole meeting.
  // Summary replacement (ticket 05): the summary surface owns the live
  // editor, so the panel's edits go through its imperative ref — BlockNote
  // and markdown edit the PM doc in one transaction, legacy splices the
  // plain block contents through the existing change callback. Nothing here
  // saves: the editor's own dirty mechanism marks the summary unsaved and
  // the ordinary save button (saveAllChanges → api_save_meeting_summary)
  // persists it, so a replace survives a reload exactly like manual typing.
  const handleSummaryReplace = useCallback(async (edits: SummaryReplaceEdit[]) => {
    return meetingData.blockNoteSummaryRef.current?.replaceSummary(edits) ?? false;
  }, [meetingData.blockNoteSummaryRef]);

  const findReplace = useFindReplace({
    segments: segments ?? [],
    summaryBlocks,
    loadAllPages: onLoadAllPages,
    // Replacement reuses the same save callback the row editor uses: the page
    // wires it to the pagination hook's optimistic setTranscriptText (with
    // rollback), and page-content fires the stale-summary hint after a
    // successful save — replaced segments therefore persist and hint exactly
    // like manually edited rows.
    onTextEdited: handleTranscriptTextEdited,
    onSummaryReplace: handleSummaryReplace,
  });
  const { openPanel, closePanel } = findReplace;

  // Navigation follows the active match across the split view: a summary
  // match reveals the summary tab, a transcript match the transcript tab.
  // The tab is only ever moved while the panel is open, and the manual
  // selection marker (the auto-switch's guard) is set like the tab strip's
  // own handler does, so the summary auto-switch never fights navigation.
  useEffect(() => {
    if (!findReplace.open) return;
    const active = findReplace.activeIndex >= 0
      ? findReplace.matches[findReplace.activeIndex]
      : undefined;
    if (!active) return;
    manuallySelectedTabMeetingIdsRef.current.add(meeting.id);
    setActiveTab(active.source === 'summary' ? 'summary' : 'transcript');
  }, [findReplace.open, findReplace.matches, findReplace.activeIndex, meeting.id]);

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
        // The selection mode owns Escape while it is open: it exits the mode
        // (clearing the id set) and CLAIMS the event, so the find panel's
        // closer below never sees it. The row editor's Escape claims earlier
        // still — the same defaultPrevented contract the panel relies on.
        if (selection.isSelecting) {
          event.preventDefault();
          exitSelection();
          return;
        }
        // A row editor's Escape cancels the edit and marks the event handled;
        // only an unclaimed Escape closes the panel.
        closePanel();
      } else if (
        (event.key === 'Delete' || event.key === 'Backspace')
        && !event.defaultPrevented
        && selection.isSelecting
        && selection.selectedCount > 0
      ) {
        // Delete removes the selection through the very same button path.
        // Backspace counts as the Delete key too: Mac laptop keyboards send
        // it for their single Delete key. A focused text field owns the key
        // (the inline editor, the find inputs): the selection never eats a
        // typing keystroke.
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        setBulkDeleteNonce(nonce => nonce + 1);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openPanel, closePanel, selection.isSelecting, selection.selectedCount, exitSelection]);

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
              onSegmentDeleted={handleSegmentDeleted}
              isDiarizing={isDiarizing}
              isRetranscribing={isRetranscribing}
              selectionMode={selection.isSelecting}
              onToggleSelection={selection.toggleSelection}
              selectedIds={selection.selectedIds}
              onToggleSelected={selection.toggleSelected}
              onSegmentsBulkDeleted={handleSegmentsBulkDeleted}
              onSelectAllVisible={handleSelectAllVisible}
              onSelectBySpeaker={handleSelectBySpeaker}
              onRowRangeSelect={handleRowRangeSelect}
              bulkDeleteNonce={bulkDeleteNonce}
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
              onOpenFind={() => openPanel({ focus: 'search' })}
              findOpen={findReplace.open}
              findMatches={findReplace.matches}
              findActiveIndex={findReplace.activeIndex}
              onSummaryBlocksChange={setSummaryBlocks}
            />
          }
        />
      </div>

      {/* The find & replace card: fixed, non-modal, sidebar-compensated. */}
      <FindReplacePanel
        open={findReplace.open}
        query={findReplace.query}
        onQueryChange={findReplace.setQuery}
        replaceText={findReplace.replaceText}
        onReplaceTextChange={findReplace.setReplaceText}
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
        onReplaceActive={findReplace.replaceActive}
        onReplaceAll={findReplace.replaceAll}
        replaceableCount={findReplace.replaceableCount}
        focusTarget={findReplace.focusTarget}
        focusNonce={findReplace.focusNonce}
        sidebarCollapsed={isCollapsed}
      />
    </motion.div>
  );
}
