"use client";

import { MeetingSummary, Summary, Transcript } from '@/types';
import type { Match, SummaryBlock } from '@/hooks/meeting-details/useFindReplace';
import { BlockNoteSummaryView, BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { EmptyStateSummary } from '@/components/EmptyStateSummary';
import { ModelConfig } from '@/components/ModelSettingsModal';
import { SummaryGeneratorButtonGroup } from './SummaryGeneratorButtonGroup';
import { SummaryUpdaterButtonGroup } from './SummaryUpdaterButtonGroup';
import { useEffect, useRef, useState, RefObject } from 'react';
import { toast } from 'sonner';
import { Languages, ChevronDown, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';
import { labelForCode } from '@/lib/summary-languages';
import {
  readMeetingSummaryLanguage,
  saveMeetingSummaryLanguage,
  SummaryLanguageStorage,
} from '@/lib/summary-language-preferences';
import { hasVisibleSummaryContent } from '@/lib/summary-content';
import { saveSummaryEditorIfDirty } from '@/lib/summary-editor-save';
import { formatMeetingDateTime } from '@/lib/meeting-datetime';
import { useTranslation } from 'react-i18next';
import i18n, { type AppLanguageCode } from '@/i18n';

interface SummaryPanelProps {
  meeting: {
    id: string;
    title: string;
    created_at: string;
    /** The meeting's own moment (RFC3339), preferred over `created_at`. */
    recorded_at?: string | null;
  };
  /**
   * The meeting's own moment (RFC3339), shown in the top-right corner of the
   * summary text window. When absent or unparsable nothing is drawn — never a
   * placeholder.
   */
  meetingDate?: string | null;
  meetingTitle: string;
  summaryRef: RefObject<BlockNoteSummaryViewRef>;
  onCopySummary: () => Promise<void>;
  onExportSummary: () => Promise<void>;
  aiSummary: MeetingSummary | null;
  summaryStatus: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error';
  transcripts: Transcript[];
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig | ((prev: ModelConfig) => ModelConfig)) => void;
  onSaveModelConfig: (config?: ModelConfig) => Promise<void>;
  onGenerateSummary: (customPrompt: string) => Promise<void>;
  onStopGeneration: () => void;
  customPrompt: string;
  /** Writes the page-owned prompt state; the field lives next to Generate. */
  onPromptChange: (value: string) => void;
  /** Keeps the prompt field's "not while recording" guard (meeting page: false). */
  isRecording?: boolean;
  onSaveSummary: (summary: MeetingSummary) => Promise<void>;
  onSummaryChange: (summary: Summary) => void;
  onDirtyChange: (isDirty: boolean) => void;
  summaryError: string | null;
  onRegenerateSummary: () => Promise<void>;
  getSummaryStatusMessage: (status: 'idle' | 'processing' | 'summarizing' | 'regenerating' | 'completed' | 'error') => string;
  availableTemplates: Array<{ id: string, name: string, description: string }>;
  selectedTemplate: string;
  onTemplateSelect: (templateId: string, templateName: string) => void;
  isModelConfigLoading?: boolean;
  onOpenModelSettings?: (openFn: () => void) => void;

  // Find & replace (meeting page only): opens the shared floating panel and
  // drives the summary highlight through the editor (ticket 04).
  onOpenFind?: () => void;
  findOpen?: boolean;
  findMatches?: Match[];
  findActiveIndex?: number;
  /** Reports the summary's searchable blocks up to the page (see the view). */
  onSummaryBlocksChange?: (blocks: SummaryBlock[]) => void;
}

export function SummaryPanel({
  meeting,
  meetingDate = null,
  meetingTitle,
  summaryRef,
  onCopySummary,
  onExportSummary,
  aiSummary,
  summaryStatus,
  transcripts,
  modelConfig,
  setModelConfig,
  onSaveModelConfig,
  onGenerateSummary,
  onStopGeneration,
  customPrompt,
  onPromptChange,
  isRecording = false,
  onSaveSummary,
  onSummaryChange,
  onDirtyChange,
  summaryError,
  onRegenerateSummary,
  getSummaryStatusMessage,
  availableTemplates,
  selectedTemplate,
  onTemplateSelect,
  isModelConfigLoading = false,
  onOpenModelSettings,
  onOpenFind,
  findOpen,
  findMatches,
  findActiveIndex,
  onSummaryBlocksChange,
}: SummaryPanelProps) {
  const { t } = useTranslation();
  const language = i18n.language as AppLanguageCode;
  const [summaryLang, setSummaryLang] = useState<string | null>(null);
  const [summaryLangStorage, setSummaryLangStorage] = useState<SummaryLanguageStorage>('metadata');
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const languageLoadVersionRef = useRef(0);
  const activeMeetingIdRef = useRef(meeting.id);
  const languageSaveVersionRef = useRef(0);
  const languageSaveLoopRunningRef = useRef(false);
  const latestLanguageSaveRequestRef = useRef<{
    version: number;
    meetingId: string;
    language: string | null;
    rollback: {
      language: string | null;
      storage: SummaryLanguageStorage;
    };
  } | null>(null);
  activeMeetingIdRef.current = meeting.id;
  const { addRecent } = useRecentLanguages();

  const effectiveLangLabel = summaryLang ? labelForCode(summaryLang) : t('summary.language.auto');
  const isLocalFallbackLanguage = summaryLangStorage === 'local_fallback';
  const autoSubtitle = isLocalFallbackLanguage
    ? t('summary.language.savedOnDevice')
    : t('summary.language.usesDominant');

  useEffect(() => {
    let cancelled = false;
    const loadVersion = languageLoadVersionRef.current + 1;
    languageLoadVersionRef.current = loadVersion;

    const loadSummaryLanguage = async () => {
      try {
        const stored = await readMeetingSummaryLanguage(meeting.id);
        if (!cancelled && languageLoadVersionRef.current === loadVersion) {
          setSummaryLang(stored.language);
          setSummaryLangStorage(stored.storage);
        }
      } catch (err) {
        console.error('Failed to load summary language:', err);
        toast.warning(t('summary.language.loadFailed'), {
          description: t('summary.language.loadFailedDescription'),
        });
        if (!cancelled && languageLoadVersionRef.current === loadVersion) setSummaryLang(null);
      }
    };

    loadSummaryLanguage();

    return () => {
      cancelled = true;
    };
  }, [meeting.id]);

  const persistLatestLanguageSelection = async () => {
    if (languageSaveLoopRunningRef.current) return;
    languageSaveLoopRunningRef.current = true;

    try {
      while (true) {
        const request = latestLanguageSaveRequestRef.current;
        if (!request) return;

        try {
          const saved = await saveMeetingSummaryLanguage(request.meetingId, request.language);
          const latest = latestLanguageSaveRequestRef.current;
          if (
            latest?.version === request.version &&
            activeMeetingIdRef.current === request.meetingId
          ) {
            setSummaryLang(saved.language);
            setSummaryLangStorage(saved.storage);
            if (saved.storage === 'local_fallback') {
              toast.info(t('summary.language.savedLocally'), {
                description: t('summary.language.savedLocallyDescription'),
              });
            }
            if (request.language) {
              addRecent(request.language);
            }
            return;
          }

          if (latest?.version === request.version) return;
        } catch (err) {
          const latest = latestLanguageSaveRequestRef.current;
          if (
            latest?.version === request.version &&
            activeMeetingIdRef.current === request.meetingId
          ) {
            console.error('Failed to persist summary language:', err);
            toast.error(t('summary.language.saveFailed'));
            setSummaryLang(request.rollback.language);
            setSummaryLangStorage(request.rollback.storage);
            return;
          }

          console.warn('Ignoring failed stale summary language save:', err);
          if (latest?.version === request.version) return;
        }
      }
    } finally {
      languageSaveLoopRunningRef.current = false;
    }
  };

  const handleLangChange = (code: string | null) => {
    const previous = summaryLang;
    const previousStorage = summaryLangStorage;
    const nextStored = code;
    languageLoadVersionRef.current += 1;
    latestLanguageSaveRequestRef.current = {
      version: languageSaveVersionRef.current + 1,
      meetingId: meeting.id,
      language: nextStored,
      rollback: {
        language: previous,
        storage: previousStorage,
      },
    };
    languageSaveVersionRef.current += 1;
    setSummaryLang(nextStored);
    setLangPickerOpen(false);
    void persistLatestLanguageSelection();
  };

  const isSummaryLoading = summaryStatus === 'processing' || summaryStatus === 'summarizing' || summaryStatus === 'regenerating';
  const hasSummary = hasVisibleSummaryContent(aiSummary);
  const formattedMeetingDate = formatMeetingDateTime(meetingDate, language);

  const languageSlot = (
    <Popover open={langPickerOpen} onOpenChange={setLangPickerOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={isLocalFallbackLanguage
            ? t('summary.language.buttonTitleLocal', { language: effectiveLangLabel })
            : t('summary.language.buttonTitle', { language: effectiveLangLabel })}
          aria-label={t('summary.language.setAria')}
        >
          <Languages size={18} />
          <span className="hidden @[40rem]:inline">{effectiveLangLabel}</span>
          <ChevronDown size={14} className="text-gray-400" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-auto p-0 border-0 shadow-none bg-transparent"
      >
        <LanguagePickerPopover
          value={summaryLang}
          onChange={handleLangChange}
          onClose={() => setLangPickerOpen(false)}
          autoSubtitle={autoSubtitle}
        />
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-white overflow-hidden h-full w-full @container">
      {/* Top-level actions — always visible, same pattern as TranscriptPanel */}
      <div className="p-4 border-b border-gray-200">
        <div className="flex items-center justify-center w-full min-w-0 gap-2 flex-wrap">
          <div className="flex-shrink-0 min-w-0">
            <SummaryGeneratorButtonGroup
              modelConfig={modelConfig}
              setModelConfig={setModelConfig}
              onSaveModelConfig={onSaveModelConfig}
              onGenerateSummary={onGenerateSummary}
              onStopGeneration={onStopGeneration}
              customPrompt={customPrompt}
              summaryStatus={summaryStatus}
              availableTemplates={availableTemplates}
              selectedTemplate={selectedTemplate}
              onTemplateSelect={onTemplateSelect}
              hasTranscripts={transcripts.length > 0}
              hasSummary={hasSummary}
              isModelConfigLoading={isModelConfigLoading}
              onOpenModelSettings={onOpenModelSettings}
              languageSlot={transcripts.length > 0 || hasSummary ? languageSlot : undefined}
            />
          </div>

          {hasSummary && !isSummaryLoading && (
            <div className="flex-shrink-0">
              <SummaryUpdaterButtonGroup
                onCopy={onCopySummary}
                onExport={onExportSummary}
              />
            </div>
          )}

          {onOpenFind && (
            <div className="flex-shrink-0">
              <Button
                size="sm"
                variant="outline"
                className="px-2"
                onClick={onOpenFind}
                title={t('findReplace.openSummaryTooltip')}
                aria-label={t('findReplace.openSummaryTooltip')}
              >
                <Search size={18} />
              </Button>
            </div>
          )}
        </div>

        {/* Custom prompt input — moved from the bottom of the transcript
            panel to sit next to the Generate group that consumes it. The
            show condition is unchanged: never while recording, and only
            when the meeting has speech segments. */}
        {!isRecording && transcripts.length > 0 && (
          <textarea
            placeholder={t('summary.promptPlaceholder')}
            className="mt-3 w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 bg-white shadow-sm min-h-[80px] resize-y"
            value={customPrompt}
            onChange={(e) => onPromptChange(e.target.value)}
          />
        )}
      </div>

      {isSummaryLoading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500 mb-4"></div>
            <p className="text-gray-600">{t('summary.generating')}</p>
          </div>
        </div>
      ) : !hasSummary ? (
        <EmptyStateSummary
          onGenerate={() => onGenerateSummary(customPrompt)}
          hasModel={modelConfig.provider !== null && modelConfig.model !== null}
          isGenerating={isSummaryLoading}
          error={summaryError}
        />
      ) : (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* The full meeting title heads the summary text window on the left,
              and the meeting's own moment sits in its top-right corner, so
              both are read next to the summary they describe. The row stays
              outside the scroll area and never scrolls away. The title shows
              even when the date is unknown; an unknown date draws nothing and
              is never replaced by the current moment (ADR-0005). */}
          <div className="flex items-start justify-between gap-4 px-6 pt-4">
            <h1 className="min-w-0 break-words text-2xl font-bold text-black">
              {meetingTitle}
            </h1>
            {formattedMeetingDate && (
              <h3 className="text-lg font-medium text-gray-500 tabular-nums whitespace-nowrap">
                {formattedMeetingDate}
              </h3>
            )}
          </div>
          <div
            className="flex-1 overflow-y-auto overflow-x-auto min-h-0 p-6"
            // Blur autosave (meeting-view-toggle, ticket 03): losing focus
            // from the editor (a click elsewhere, the tab strip, the window)
            // persists unsaved edits through the same save chain the removed
            // Save button used. React's onBlur bubbles (focusout), so the
            // wrapper catches the contenteditable's blur; the shared helper
            // keeps the call dirty-only and reports a failed save.
            onBlur={() => {
              void saveSummaryEditorIfDirty(summaryRef.current);
            }}
          >
            <BlockNoteSummaryView
              ref={summaryRef}
              summaryData={aiSummary}
              onSave={onSaveSummary}
              onSummaryChange={onSummaryChange}
              onDirtyChange={onDirtyChange}
              findOpen={findOpen}
              findMatches={findMatches}
              findActiveIndex={findActiveIndex}
              onSummaryBlocksChange={onSummaryBlocksChange}
              status={summaryStatus}
              error={summaryError}
              onRegenerateSummary={() => {
                onRegenerateSummary();
              }}
              meeting={{
                id: meeting.id,
                title: meetingTitle,
                created_at: meeting.created_at,
                // Passed through so the legacy export dates from the meeting
                // itself, not from when the database row appeared.
                recorded_at: meeting.recorded_at ?? meetingDate
              }}
            />
            {summaryStatus !== 'idle' && (
              <div className={`mt-4 p-4 rounded-lg ${summaryStatus === 'error' ? 'bg-red-100 text-red-700' :
                summaryStatus === 'completed' ? 'bg-green-100 text-green-700' :
                  'bg-blue-100 text-blue-700'
                }`}>
                <p className="text-sm font-medium">{getSummaryStatusMessage(summaryStatus)}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
