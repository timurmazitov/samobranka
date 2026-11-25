"use client";

import { MeetingSpeaker, Transcript, TranscriptSegmentData } from '@/types';
import { TranscriptView } from '@/components/TranscriptView';
import { VirtualizedTranscriptView } from '@/components/VirtualizedTranscriptView';
import { TranscriptButtonGroup } from './TranscriptButtonGroup';
import { usePanelToolbar } from './panel-toolbar';
import type { Match } from '@/hooks/meeting-details/useFindReplace';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/i18n';

interface TranscriptPanelProps {
  transcripts: Transcript[];
  /**
   * Page-owned custom-prompt text for summary generation. The editable field
   * sits at the bottom of this panel (meeting-view-toggle, ticket 06); when
   * the props are omitted (standalone use) the field is not rendered.
   */
  customPrompt?: string;
  onPromptChange?: (value: string) => void;
  onCopyTranscript: () => void;
  onExportTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  isRecording: boolean;
  disableAutoScroll?: boolean;

  // Optional pagination props (when using virtualization)
  usePagination?: boolean;
  segments?: TranscriptSegmentData[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  totalCount?: number;
  loadedCount?: number;
  onLoadMore?: () => void;

  // Retranscription props
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;

  // Speakers of this meeting (per-row dropdown on the meeting page)
  meetingSpeakers?: MeetingSpeaker[];
  onSpeakerChanged?: (transcriptId: string, label: string | null) => void | Promise<void>;

  // Inline text editing of a saved row (meeting page only)
  onTextEdited?: (transcriptId: string, text: string) => void | Promise<void>;
  /** Single-segment delete of a saved row (meeting page only). */
  onSegmentDeleted?: (transcriptId: string) => void | Promise<void>;
  /** Whether a diarization pass runs for this meeting; closes text editing. */
  isDiarizing?: boolean;
  /** Whether a retranscription runs for this meeting; closes segment deletion. */
  isRetranscribing?: boolean;

  // Bulk selection mode (ticket 02, meeting page only). The page owns the id
  // set; the panel only threads the toolbar toggle and the row checkboxes.
  selectionMode?: boolean;
  onToggleSelection?: () => void;
  selectedIds?: string[];
  onToggleSelected?: (transcriptId: string) => void;
  onSegmentsBulkDeleted?: (transcriptIds: string[]) => void | Promise<void>;
  /** Leave the selection mode and clear the ids (ticket 04, pencil click). */
  onExitSelection?: () => void;
  // Ticket 03's assistants + keyboard seam, threaded to the view's bar.
  onSelectAllVisible?: () => void;
  onSelectBySpeaker?: (label: string) => void;
  onRowRangeSelect?: (transcriptId: string, modifiers: { shift: boolean }) => void;
  bulkDeleteNonce?: number;

  // Find & replace (meeting page only): opens the floating panel and drives
  // the row highlights through the virtualized view.
  onOpenFind?: () => void;
  findOpen?: boolean;
  findMatches?: Match[];
  findActiveIndex?: number;
}

export function TranscriptPanel({
  transcripts,
  customPrompt,
  onPromptChange,
  onCopyTranscript,
  onExportTranscript,
  onOpenMeetingFolder,
  isRecording,
  disableAutoScroll = false,
  usePagination = false,
  segments,
  hasMore,
  isLoadingMore,
  totalCount,
  loadedCount,
  onLoadMore,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  meetingSpeakers,
  onSpeakerChanged,
  onTextEdited,
  onSegmentDeleted,
  isDiarizing,
  isRetranscribing,
  selectionMode,
  onToggleSelection,
  selectedIds,
  onToggleSelected,
  onSegmentsBulkDeleted,
  onExitSelection,
  onSelectAllVisible,
  onSelectBySpeaker,
  onRowRangeSelect,
  bulkDeleteNonce,
  onOpenFind,
  findOpen,
  findMatches,
  findActiveIndex,
}: TranscriptPanelProps) {
  // Convert transcripts to segments if pagination is not used but we want virtualization
  const convertedSegments = useMemo(() => {
    if (usePagination && segments) {
      return segments;
    }
    // Convert transcripts to segments for virtualization
    return transcripts.map(t => ({
      id: t.id,
      timestamp: t.audio_start_time ?? 0,
      endTime: t.audio_end_time,
      text: t.text,
      confidence: t.confidence,
      speaker: t.speaker,
      speaker_name: t.speaker_name,
    }));
  }, [transcripts, usePagination, segments]);

  const { t } = useTranslation();
  const toolbar = (
    <TranscriptButtonGroup
      transcriptCount={usePagination ? (totalCount ?? convertedSegments.length) : (transcripts?.length || 0)}
      onCopyTranscript={onCopyTranscript}
      onExportTranscript={onExportTranscript}
      onOpenMeetingFolder={onOpenMeetingFolder}
      meetingId={meetingId}
      meetingFolderPath={meetingFolderPath}
      onRefetchTranscripts={onRefetchTranscripts}
      onOpenFind={onOpenFind}
      onToggleSelection={onToggleSelection}
      selectionMode={selectionMode}
      isRecording={isRecording}
      isDiarizing={isDiarizing}
      isRetranscribing={isRetranscribing}
    />
  );
  // Inside the split view the button row renders in the shared toolbar bar
  // (next to the «Транспект / Конспект» toggles); standalone it stays here.
  const toolbarInBar = usePanelToolbar(toolbar);

  return (
    <div className="flex h-full min-w-0 w-full bg-white flex-col relative @container">
      {/* Title area — locally only when no split view captured the buttons */}
      {!toolbarInBar && (
        <div className="p-4 border-b border-gray-200">
          {toolbar}
        </div>
      )}

      {/* Transcript content - use virtualized view for better performance */}
      <div className="flex-1 overflow-hidden pb-4">
        <VirtualizedTranscriptView
          segments={convertedSegments}
          isRecording={isRecording}
          isPaused={false}
          isProcessing={false}
          isStopping={false}
          enableStreaming={false}
          showConfidence={true}
          disableAutoScroll={disableAutoScroll}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          totalCount={totalCount}
          loadedCount={loadedCount}
          onLoadMore={onLoadMore}
          meetingSpeakers={meetingSpeakers}
          onSpeakerChange={onSpeakerChanged}
          onTextEdited={onTextEdited}
          onSegmentDeleted={onSegmentDeleted}
          isDiarizing={isDiarizing}
          isRetranscribing={isRetranscribing}
          selectionMode={selectionMode}
          selectedIds={selectedIds}
          onToggleSelected={onToggleSelected}
          onSegmentsBulkDeleted={onSegmentsBulkDeleted}
          onExitSelection={onExitSelection}
          onSelectAllVisible={onSelectAllVisible}
          onSelectBySpeaker={onSelectBySpeaker}
          onRowRangeSelect={onRowRangeSelect}
          bulkDeleteNonce={bulkDeleteNonce}
          findOpen={findOpen}
          findMatches={findMatches}
          findActiveIndex={findActiveIndex}
        />
      </div>

      {/* Custom prompt input at the bottom of the transcript section — below
          the list of lines, hidden in summary mode with the panel itself.
          The value travels to the summary panel's Generate button through
          the page state (meeting-view-toggle, ticket 06). */}
      {customPrompt !== undefined && onPromptChange !== undefined && !isRecording && convertedSegments.length > 0 && (
        <div className="p-1 border-t border-gray-200">
          <textarea
            placeholder={t('summary.promptPlaceholder')}
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange!(e.target.value)}
          />
        </div>
      )}
    </div>
  );
}
