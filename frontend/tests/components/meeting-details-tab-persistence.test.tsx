import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for tab-choice persistence (meeting-view-toggle, ticket 02):
// the meeting page owns the «Конспект / Транскрипт» tab state, so it is where
// the globally remembered choice is read (initial tab of any opened meeting)
// and written (manual switch). The heavy panels and data hooks are stand-ins
// (the same harness as meeting-details-mode-exclusivity); the split view stub
// captures its props so the tests observe the controlled activeTab contract
// exactly as the real Radix Tabs would drive it.

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
const originalUseMeetingData = { ...await import('../../src/hooks/meeting-details/useMeetingData') };
const originalUseSummaryGeneration = { ...await import('../../src/hooks/meeting-details/useSummaryGeneration') };
const originalUseTemplates = { ...await import('../../src/hooks/meeting-details/useTemplates') };
const originalUseCopyOperations = { ...await import('../../src/hooks/meeting-details/useCopyOperations') };
const originalUseMeetingOperations = { ...await import('../../src/hooks/meeting-details/useMeetingOperations') };

const noopNotify = mock((..._args: unknown[]) => {});
let splitViewProps: Record<string, any>;
// Read through getters so a test can flip them between renders without
// re-mocking (the summary-hint suite's pattern).
let aiSummary: unknown = null;
let summaryStatus = 'idle';

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
    TranscriptPanel: () => <div />,
  }));
  mock.module('../../src/components/MeetingDetails/SummaryPanel', () => ({
    SummaryPanel: () => <div />,
  }));
  mock.module('../../src/components/MeetingDetails/MeetingDetailsSplitView', () => ({
    MeetingDetailsSplitView: (props: any) => {
      splitViewProps = props;
      return <div>{props.transcript}{props.summary}</div>;
    },
  }));
  mock.module('../../src/components/ModelSettingsModal', () => ({ ModelConfig: {} }));
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => ({
    useMeetingData: () => ({
      transcripts: [],
      get aiSummary() { return aiSummary; },
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
      get summaryStatus() { return summaryStatus; },
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
    useMeetingOperations: () => ({ handleOpenMeetingFolder: async () => {} }),
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
  mock.module('../../src/components/ModelSettingsModal', () => originalModelSettings);
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => originalUseMeetingData);
  mock.module('../../src/hooks/meeting-details/useSummaryGeneration', () => originalUseSummaryGeneration);
  mock.module('../../src/hooks/meeting-details/useTemplates', () => originalUseTemplates);
  mock.module('../../src/hooks/meeting-details/useCopyOperations', () => originalUseCopyOperations);
  mock.module('../../src/hooks/meeting-details/useMeetingOperations', () => originalUseMeetingOperations);
});

const MEETING_DETAILS_ACTIVE_TAB_KEY = 'samobranka.meetingDetails.activeTab';

// The tab preference lives in localStorage; bun has no window, so each test
// gets a fresh Map-backed stand-in (the panel-meeting-date shim's shape) and
// the previous global is restored afterwards.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const stored = new Map<string, string>();

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  noopNotify.mockClear();
  splitViewProps = undefined as any;
  aiSummary = null;
  summaryStatus = 'idle';
  stored.clear();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      matchMedia: () => ({
        matches: true,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
      },
    },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

async function show(meetingId = 'meeting-a') {
  await act(async () => {
    renderer = create(
      <PageContent
        meeting={{ id: meetingId, title: 'Meeting', transcripts: [] }}
        summaryData={null}
        initialSummary={null}
        segments={[]}
      />,
    );
  });
}

describe('meeting tab choice persistence', () => {
  test('with nothing stored the meeting opens on the summary tab', async () => {
    await show();

    expect(splitViewProps.activeTab).toBe('summary');
  });

  test('a stored transcript choice is restored as the initial tab', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'transcript');

    await show();

    expect(splitViewProps.activeTab).toBe('transcript');
  });

  test('a garbage stored value falls back to the summary default', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'bogus');

    await show();

    expect(splitViewProps.activeTab).toBe('summary');
  });

  test('a manual tab switch is written to storage and applied', async () => {
    await show();

    await act(async () => { splitViewProps.onTabChange('transcript'); });

    expect(splitViewProps.activeTab).toBe('transcript');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });

  test('a manual choice on one meeting is the initial tab of the next meeting opened', async () => {
    await show('meeting-a');
    await act(async () => { splitViewProps.onTabChange('transcript'); });
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;

    await show('meeting-b');

    expect(splitViewProps.activeTab).toBe('transcript');
  });

  // Story 6 beats the auto-switch on open: a meeting that ALREADY has a
  // summary restores it asynchronously after mount, which must not move the
  // tab off the stored choice — only a generation completing during this
  // viewing session may (story 5).
  test('a meeting with an existing summary opens on the stored tab', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'transcript');
    aiSummary = { summary_json: [{ id: 'b1', type: 'paragraph', content: [] }] };
    summaryStatus = 'completed';

    await show();

    expect(splitViewProps.activeTab).toBe('transcript');
    // The stored choice is left untouched.
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });

  test('a meeting with an existing summary and nothing stored opens on the default summary tab', async () => {
    aiSummary = { summary_json: [{ id: 'b1', type: 'paragraph', content: [] }] };
    summaryStatus = 'completed';

    await show();

    expect(splitViewProps.activeTab).toBe('summary');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBeUndefined();
  });

  // The auto-switch on summary completion (spec story 5) is preserved: the
  // globally remembered transcript choice is not a manual choice for THIS
  // meeting, so the tab still moves to the summary when generation finishes —
  // and the automatic move is not persisted as if it were a manual choice.
  test('summary completion auto-switches the tab without overwriting the stored choice', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'transcript');
    summaryStatus = 'processing';
    await show();
    expect(splitViewProps.activeTab).toBe('transcript');

    summaryStatus = 'completed';
    await act(async () => {
      renderer!.update(
        <PageContent
          meeting={{ id: 'meeting-a', title: 'Meeting', transcripts: [] }}
          summaryData={null}
          initialSummary={null}
          segments={[]}
        />,
      );
    });

    expect(splitViewProps.activeTab).toBe('summary');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });

  // Spec story 7: the manual choice for this meeting beats the auto-switch
  // (and, being applied after mount, the globally remembered mode too).
  test('a manual choice for the meeting is not overridden by summary completion', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'summary');
    summaryStatus = 'processing';
    await show();
    await act(async () => { splitViewProps.onTabChange('transcript'); });
    expect(splitViewProps.activeTab).toBe('transcript');

    summaryStatus = 'completed';
    await act(async () => {
      renderer!.update(
        <PageContent
          meeting={{ id: 'meeting-a', title: 'Meeting', transcripts: [] }}
          summaryData={null}
          initialSummary={null}
          segments={[]}
        />,
      );
    });

    expect(splitViewProps.activeTab).toBe('transcript');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });
});
