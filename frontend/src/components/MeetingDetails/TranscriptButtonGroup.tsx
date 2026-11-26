"use client";

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Separator } from '@/components/ui/separator';
import { TOOLBAR_MODE_GROUP_MIN_WIDTH } from './panel-toolbar';
import { Copy, Download, FolderOpen, RefreshCw, Search, SquareCheck, Users } from 'lucide-react';
import { RetranscribeDialog } from './RetranscribeDialog';
import { SpeakersPanel } from './SpeakersPanel';
import type { DiarizationClient } from '@/lib/diarization';
import type { AudioCppModelClient } from '@/lib/audiocpp';
import { useTranslation } from 'react-i18next';
import '@/i18n';


export interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onExportTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
  /** Opens the floating find & replace panel (meeting page). Absent elsewhere. */
  onOpenFind?: () => void;
  /**
   * Bulk selection mode (ticket 02): present on the meeting page only, so
   * the «Выделение» toggle appears there and never on the live page. The
   * owner (page-content) keeps the id set; the group only flips the mode.
   */
  onToggleSelection?: () => void;
  /** Whether the selection mode is currently on (drives the active style). */
  selectionMode?: boolean;
  /**
   * The delete gates (spec: selection shares single delete's gates). The
   * meeting page passes all three; any one of them disables the toggle.
   */
  isRecording?: boolean;
  isDiarizing?: boolean;
  isRetranscribing?: boolean;
  /** Panel seams, forwarded so component tests can inject fakes. */
  diarizationClient?: DiarizationClient;
  diarizationModelClient?: Pick<AudioCppModelClient, 'getAvailableModels'> &
    Partial<Pick<AudioCppModelClient, 'getDiagnostics'>>;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onExportTranscript,
  onOpenMeetingFolder,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
  onOpenFind,
  onToggleSelection,
  selectionMode = false,
  isRecording = false,
  isDiarizing = false,
  isRetranscribing = false,
  diarizationClient,
  diarizationModelClient,
}: TranscriptButtonGroupProps) {
  const { t } = useTranslation();
  const [showRetranscribeDialog, setShowRetranscribeDialog] = useState(false);
  const [showSpeakersPanel, setShowSpeakersPanel] = useState(false);

  const handleRetranscribeComplete = useCallback(async () => {
    // Refetch transcripts to show the updated data
    if (onRefetchTranscripts) {
      await onRefetchTranscripts();
    }
  }, [onRefetchTranscripts]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ButtonGroup className={TOOLBAR_MODE_GROUP_MIN_WIDTH}>
        <Button
          size="sm"
          variant="outline"
          className="px-2 @[22rem]:px-3"
          onClick={() => {
            setShowSpeakersPanel(true);
          }}
          title={t('speakers.title')}
        >
          <Users size={18} />
          <span className="hidden @[22rem]:inline">{t('speakers.title')}</span>
        </Button>

        {onOpenFind && (
          <Button
            size="sm"
            variant="outline"
            className="px-2 @[22rem]:px-3"
            onClick={onOpenFind}
            title={t('findReplace.openTooltip')}
            aria-label={t('findReplace.openTooltip')}
          >
            <Search size={18} />
            <span className="hidden @[22rem]:inline">{t('findReplace.find')}</span>
          </Button>
        )}

        {meetingId && meetingFolderPath && (
          <Button
            size="sm"
            variant="outline"
            className="px-2 @[22rem]:px-4"
            onClick={() => {
              setShowRetranscribeDialog(true);
            }}
            title={t('transcript.enhanceTitle')}
          >
            <RefreshCw className="@[22rem]:mr-2" size={18} />
            <span className="hidden @[22rem]:inline">{t('transcript.enhance')}</span>
          </Button>
        )}

        <Button
          size="sm"
          variant="outline"
          className="px-2 @[22rem]:px-4"
          onClick={() => {
            onOpenMeetingFolder();
          }}
          title={t('transcript.openRecordingFolder')}
        >
          <FolderOpen className="@[22rem]:mr-2" size={18} />
          <span className="hidden @[22rem]:inline">{t('transcript.recording')}</span>
        </Button>

        {/* Bulk selection mode (ticket 02). Same shape as the Find toggle;
            the mode's gates are single delete's gates (spec), so
            recording/diarization/retranscription disable it. The active mode
            reads as a filled button among the group's outline buttons. */}
        {onToggleSelection && (
          <Button
            size="sm"
            variant={selectionMode ? 'secondary' : 'outline'}
            className="px-2 @[22rem]:px-3"
            onClick={onToggleSelection}
            disabled={isRecording || isDiarizing || isRetranscribing}
            title={t('transcript.selectModeTooltip')}
            aria-label={t('transcript.selectModeTooltip')}
            aria-pressed={selectionMode}
          >
            <SquareCheck size={18} />
            <span className="hidden @[22rem]:inline">{t('transcript.selectMode')}</span>
          </Button>
        )}
      </ButtonGroup>

      {/* Copy/Export live in their own group behind a divider, mirroring the
          summary toolbar (SummaryPanel's Separator between the two groups). */}
      <div className="flex flex-shrink-0 items-center gap-2">
        <Separator orientation="vertical" className="self-stretch" />

        <ButtonGroup>
          <Button
            variant="outline"
            size="sm"
            className="px-2 @[22rem]:px-3"
            onClick={() => {
              onCopyTranscript();
            }}
            disabled={transcriptCount === 0}
            title={transcriptCount === 0 ? t('transcript.noTranscript') : t('transcript.copyTooltip')}
          >
            <Copy />
            <span className="hidden @[22rem]:inline">{t('common.copy')}</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="px-2 @[22rem]:px-3"
            onClick={() => {
              onExportTranscript();
            }}
            disabled={transcriptCount === 0}
            title={transcriptCount === 0 ? t('transcript.noTranscript') : t('transcript.exportTitle')}
          >
            <Download />
            <span className="hidden @[22rem]:inline">{t('transcript.exportButton')}</span>
          </Button>
        </ButtonGroup>
      </div>

      <SpeakersPanel
        open={showSpeakersPanel}
        onOpenChange={setShowSpeakersPanel}
        meetingId={meetingId}
        onRefetchTranscripts={onRefetchTranscripts}
        diarizationClient={diarizationClient}
        modelClient={diarizationModelClient}
      />

      {meetingId && meetingFolderPath && (
        <RetranscribeDialog
          open={showRetranscribeDialog}
          onOpenChange={setShowRetranscribeDialog}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onComplete={handleRetranscribeComplete}
        />
      )}
    </div>
  );
}
