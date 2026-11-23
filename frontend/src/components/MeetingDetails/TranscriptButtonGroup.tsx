"use client";

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Download, FolderOpen, RefreshCw, Users } from 'lucide-react';
import { RetranscribeDialog } from './RetranscribeDialog';
import { SpeakersPanel } from './SpeakersPanel';
import type { DiarizationClient } from '@/lib/diarization';
import type { AudioCppModelClient } from '@/lib/audiocpp';
import { useTranslation } from 'react-i18next';
import '@/i18n';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onExportTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
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
    <div className="flex items-center justify-center w-full gap-2">
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
      </ButtonGroup>

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
