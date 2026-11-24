import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for ticket 04: the meeting page's find & replace state must
// reach the summary side — the summary surface reports its searchable blocks
// up so the hook builds the combined list, the active match drives the
// mobile split tab, and the summary header's Search button opens the same
// panel. The heavy panels are stand-ins that capture their props; the real
// useFindReplace hook and the real page composition stay in play, so the
// tests observe what page-content actually wires.

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
let splitViewProps: Record<string, any>;
let findPanelProps: Record<string, any>;

const AI_SUMMARY = {
  summary_json: [
    { id: 'sb1', type: 'paragraph', content: [{ type: 'text', text: 'alpha in the summary', styles: {} }] },
  ],
};

function applyMocks() {
  mock.module('sonner', () => ({
    toast: { info: noopNotify, success: noopNotify, error: noopNotify, warning: noopNotify },
  }));
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
      splitViewProps = props;
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
      blockNoteSummaryRef: { current: null },
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

// What the real summary view would report for AI_SUMMARY through the panel
// prop: one searchable block, its concatenated inline text.
const SUMMARY_BLOCKS = [{ blockId: 'sb1', text: 'alpha in the summary' }];

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  panelProps = undefined as any;
  summaryPanelProps = undefined as any;
  splitViewProps = undefined as any;
  findPanelProps = undefined as any;
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
  // The summary surface reports its searchable blocks once mounted.
  await act(async () => { summaryPanelProps.onSummaryBlocksChange(SUMMARY_BLOCKS); });
}

async function setQuery(query: string) {
  await act(async () => { findPanelProps.onQueryChange(query); });
}

async function next() {
  await act(async () => { findPanelProps.onNext(); });
}

describe('summary side of the meeting find & replace panel', () => {
  test('the combined list covers transcript then summary and the tab follows the active match', async () => {
    await show();
    // Open through the transcript header button, exactly as the UI does.
    await act(async () => { panelProps.onOpenFind(); });
    expect(findPanelProps.open).toBe(true);

    await setQuery('alpha');
    // 2 transcript hits then the summary hit: one list, one counter.
    expect(findPanelProps.total).toBe(3);
    expect(findPanelProps.current).toBe(1);
    // The active match is still on the transcript side: the tab stays.
    expect(splitViewProps.activeTab).toBe('transcript');

    await next();
    expect(findPanelProps.current).toBe(2);
    expect(splitViewProps.activeTab).toBe('transcript');

    // Crossing into the summary switches the split view's tab.
    await next();
    expect(findPanelProps.current).toBe(3);
    expect(splitViewProps.activeTab).toBe('summary');

    // And back across the cycle boundary it returns to the transcript tab.
    await next();
    expect(findPanelProps.current).toBe(1);
    expect(splitViewProps.activeTab).toBe('transcript');
  });

  test('summary matches reach the summary view so it can highlight them', async () => {
    await show();
    await act(async () => { panelProps.onOpenFind(); });
    await setQuery('alpha');
    await next();
    await next();

    // The active match is now the summary block: the view received the
    // combined list and the active index through its props.
    expect(summaryPanelProps.findOpen).toBe(true);
    expect(summaryPanelProps.findMatches.map((m: { source: string }) => m.source)).toEqual([
      'transcript', 'transcript', 'summary',
    ]);
    expect(summaryPanelProps.findActiveIndex).toBe(2);
  });

  test('closing the panel disarms the summary highlight', async () => {
    await show();
    await act(async () => { panelProps.onOpenFind(); });
    await setQuery('alpha');
    await act(async () => { findPanelProps.onClose(); });

    expect(summaryPanelProps.findOpen).toBe(false);
    expect(summaryPanelProps.findMatches).toEqual([]);
    expect(summaryPanelProps.findActiveIndex).toBe(-1);
  });

  test('the summary header Search button opens the same panel', async () => {
    await show();
    expect(summaryPanelProps.onOpenFind).toBeTypeOf('function');

    await act(async () => { summaryPanelProps.onOpenFind(); });
    expect(findPanelProps.open).toBe(true);
    expect(findPanelProps.focusTarget).toBe('search');
  });
});
