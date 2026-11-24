import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The page seam for ticket 05: the hook's summary-replacement calls must
// reach the summary surface through meetingData.blockNoteSummaryRef —
// the same ref the save button uses. The heavy panels stay stand-ins that
// capture props (same composition as the ticket-04 navigation suite), while
// the real useFindReplace hook, the real page composition, and a recording
// ref observe the wiring: single replace sends one edit, replace-all sends
// the whole batch in one call, and the «Заменить все (N)» count covers both
// sources.

const Container = ({ children }: any) => <div>{children}</div>;

const originalToast = { ...await import('sonner') };
const originalTooltip = { ...await import('../../src/components/ui/tooltip') };
const originalMotion = { ...await import('framer-motion') };
const originalSidebar = { ...await import('../../src/components/Sidebar/SidebarProvider') };
const originalConfig = { ...await import('../../src/contexts/ConfigContext') };
const originalTranscriptPanel = { ...await import('../../src/components/MeetingDetails/TranscriptPanel') };
const originalSummaryPanel = { ...await import('../../src/components/MeetingDetails/SummaryPanel') };
const originalSplitView = { ...await import('../../src/components/MeetingDetails/MeetingDetailsSplitView') };
const originalModelSettings = { ...await import('../../src/components/ModelSettingsModal') };
const originalFindReplacePanel = { ...await import('../../src/components/MeetingDetails/FindReplacePanel') };
const originalUseMeetingData = { ...await import('../../src/hooks/meeting-details/useMeetingData') };
const originalUseSummaryGeneration = { ...await import('../../src/hooks/meeting-details/useSummaryGeneration') };
const originalUseTemplates = { ...await import('../../src/hooks/meeting-details/useTemplates') };
const originalUseCopyOperations = { ...await import('../../src/hooks/meeting-details/useCopyOperations') };
const originalUseMeetingOperations = { ...await import('../../src/hooks/meeting-details/useMeetingOperations') };

const noopNotify = mock((..._args: unknown[]) => {});
let panelProps: Record<string, any>;
let summaryPanelProps: Record<string, any>;
let findPanelProps: Record<string, any>;
let replaceSummaryCalls: any[][];
// What the ref answers: true = applied, false = skipped (stale ranges).
let replaceSummaryResult = true;

const AI_SUMMARY = {
  summary_json: [
    { id: 'sb1', type: 'paragraph', content: [{ type: 'text', text: 'alpha in the summary', styles: {} }] },
  ],
};

function applyMocks() {
  mock.module('sonner', () => {
    toast: undefined;
    return { toast: { info: noopNotify, success: noopNotify, error: noopNotify, warning: noopNotify } };
  });
  mock.module('../../src/components/ui/tooltip', () => ({
    Tooltip: Container,
    TooltipTrigger: Container,
    TooltipContent: Container,
    TooltipProvider: Container,
  }));
  mock.module('framer-motion', () => ({
    motion: new Proxy({}, { get: () => (props: any) => <div>{props.children}</div> }),
    AnimatePresence: Container,
  }));
  mock.module('../../src/components/Sidebar/SidebarProvider', () => ({
    useSidebar: () => ({ serverAddress: '', isCollapsed: false }),
  }));
  mock.module('../../src/contexts/ConfigContext', () => ({
    useConfig: () => ({
      modelConfig: { provider: 'ollama', model: 'test', whisperModel: 'base' },
      setModelConfig: () => {},
      isModelConfigLoading: false,
    }),
  }));
  mock.module('../../src/components/MeetingDetails/TranscriptPanel', () => ({
    TranscriptPanel: (props: any) => {
      panelProps = props;
      return <div />;
    },
  }));
  mock.module('../../src/components/MeetingDetails/SummaryPanel', () => ({
    SummaryPanel: (props: any) => {
      summaryPanelProps = props;
      return <div />;
    },
  }));
  mock.module('../../src/components/MeetingDetails/MeetingDetailsSplitView', () => ({
    MeetingDetailsSplitView: (props: any) => {
      return <div>{props.transcript}{props.summary}</div>;
    },
  }));
  mock.module('../../src/components/MeetingDetails/FindReplacePanel', () => ({
    FindReplacePanel: (props: any) => {
      findPanelProps = props;
      return <div />;
    },
  }));
  mock.module('../../src/components/ModelSettingsModal', () => ({ ModelConfig: {} }));
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => ({
    useMeetingData: () => ({
      transcripts: [],
      aiSummary: AI_SUMMARY,
      meetingTitle: 'Meeting',
      blockNoteSummaryRef: {
        current: {
          saveSummary: async () => {},
          getMarkdown: async () => '',
          isDirty: false,
          replaceSummary: (edits: any[]) => {
            replaceSummaryCalls.push(edits);
            return replaceSummaryResult;
          },
        },
      },
      isSaving: false,
      isSummaryDirty: false,
      saveAllChanges: async () => {},
      setAiSummary: () => {},
      updateMeetingTitle: () => {},
      handleSaveSummary: async () => {},
      handleSummaryChange: () => {},
      setIsSummaryDirty: () => {},
    }),
  }));
  mock.module('../../src/hooks/meeting-details/useSummaryGeneration', () => ({
    useSummaryGeneration: () => ({
      summaryStatus: 'completed',
      handleRegenerateSummary: async () => {},
      handleGenerateSummary: async () => {},
      handleStopGeneration: async () => {},
      summaryError: null,
      getSummaryStatusMessage: () => '',
    }),
  }));
  mock.module('../../src/hooks/meeting-details/useTemplates', () => ({
    useTemplates: () => ({
      availableTemplates: [],
      selectedTemplate: 'daily_standup',
      handleTemplateSelection: () => {},
    }),
  }));
  mock.module('../../src/hooks/meeting-details/useCopyOperations', () => ({
    useCopyOperations: () => ({
      handleCopyTranscript: async () => {},
      handleExportTranscript: async () => {},
      handleCopySummary: async () => {},
      handleExportSummary: async () => {},
    }),
  }));
  mock.module('../../src/hooks/meeting-details/useMeetingOperations', () => ({
    handleOpenMeetingFolder: async () => {},
  }));
}

applyMocks();

await import('../../src/i18n');
const { default: PageContent } = await import('../../src/app/meeting-details/page-content');

afterAll(() => {
  mock.module('sonner', () => originalToast);
  mock.module('../../src/components/ui/tooltip', () => originalTooltip);
  mock.module('framer-motion', () => originalMotion);
  mock.module('../../src/components/Sidebar/SidebarProvider', () => originalSidebar);
  mock.module('../../src/contexts/ConfigContext', () => originalConfig);
  mock.module('../../src/components/MeetingDetails/TranscriptPanel', () => originalTranscriptPanel);
  mock.module('../../src/components/MeetingDetails/SummaryPanel', () => originalSummaryPanel);
  mock.module('../../src/components/MeetingDetails/MeetingDetailsSplitView', () => originalSplitView);
  mock.module('../../src/components/MeetingDetails/FindReplacePanel', () => originalFindReplacePanel);
  mock.module('../../src/components/ModelSettingsModal', () => originalModelSettings);
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => originalUseMeetingData);
  mock.module('../../src/hooks/meeting-details/useSummaryGeneration', () => originalUseSummaryGeneration);
  mock.module('../../src/hooks/meeting-details/useTemplates', () => originalUseTemplates);
  mock.module('../../src/hooks/meeting-details/useCopyOperations', () => originalUseCopyOperations);
  mock.module('../../src/hooks/meeting-details/useMeetingOperations', () => originalUseMeetingOperations);
});

const SEGMENTS = [
  { id: 's1', timestamp: 0, text: 'alpha in the transcript' },
  { id: 's2', timestamp: 1, text: 'alpha again here' },
];

// What the real summary view reports for AI_SUMMARY through the panel prop.
const SUMMARY_BLOCKS = [{ blockId: 'sb1', text: 'alpha in the summary' }];

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  panelProps = undefined as any;
  summaryPanelProps = undefined as any;
  findPanelProps = undefined as any;
  replaceSummaryCalls = [];
  replaceSummaryResult = true;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function show() {
  await act(async () => {
    renderer = create(
      <PageContent
        meeting={{ id: 'meeting-a', title: 'Meeting', transcripts: [] }}
        summaryData={AI_SUMMARY}
        initialSummary={null}
        segments={SEGMENTS}
      />,
    );
  });
  await act(async () => { summaryPanelProps.onSummaryBlocksChange(SUMMARY_BLOCKS); });
  await act(async () => { panelProps.onOpenFind(); });
  await act(async () => { findPanelProps.onQueryChange('alpha'); });
}

describe('summary replacement wiring through the page', () => {
  test('«Заменить все» counts transcript and summary matches together', async () => {
    await show();
    // 2 transcript + 1 summary match on one counter — and the same three are
    // replaceable now that the summary has a host path.
    expect(findPanelProps.total).toBe(3);
    expect(findPanelProps.replaceableCount).toBe(3);
  });

  test('replacing the active summary match calls the summary ref with one edit', async () => {
    await show();
    // Walk to the summary match (the combined list is transcript-first).
    await act(async () => { findPanelProps.onNext(); });
    await act(async () => { findPanelProps.onNext(); });
    expect(findPanelProps.current).toBe(3);

    await act(async () => { findPanelProps.onReplaceTextChange('Zeta'); });
    await act(async () => { await findPanelProps.onReplaceActive(); });

    expect(replaceSummaryCalls).toHaveLength(1);
    expect(replaceSummaryCalls[0]).toEqual([
      { blockId: 'sb1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
    ]);
  });

  test('replace-all sends the whole summary batch to the ref in one call', async () => {
    await show();
    await act(async () => {
      summaryPanelProps.onSummaryBlocksChange([
        { blockId: 'sb1', text: 'alpha and alpha again' },
      ]);
    });
    await act(async () => { findPanelProps.onReplaceTextChange('Zeta'); });
    await act(async () => { await findPanelProps.onReplaceAll(); });

    // One call, both block edits, with the expected texts the ranges held.
    expect(replaceSummaryCalls).toHaveLength(1);
    expect(replaceSummaryCalls[0]).toEqual([
      { blockId: 'sb1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
      { blockId: 'sb1', from: 10, to: 15, expected: 'alpha', replacement: 'Zeta' },
    ]);
  });

  test('a skipped summary batch keeps the matches in the list', async () => {
    // The ref aborts (user edited under the panel): no crash, no lost
    // matches — the list still shows what the text actually holds.
    replaceSummaryResult = false;
    await show();
    expect(findPanelProps.replaceableCount).toBe(3);

    await act(async () => { findPanelProps.onReplaceTextChange('Zeta'); });
    await act(async () => { await findPanelProps.onReplaceAll(); });

    expect(replaceSummaryCalls).toHaveLength(1);
    expect(findPanelProps.total).toBe(3);
  });
});
