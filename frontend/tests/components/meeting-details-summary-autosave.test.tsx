import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for the summary autosave on tab switch (meeting-view-toggle,
// ticket 03): leaving the summary tab unmounts its editor and nulls the
// editor ref, so the page must persist unsaved edits through the editor's ref
// API BEFORE applying the tab state change — never a save-vs-unmount race.
// The heavy panels and data hooks are stand-ins (the same harness as
// meeting-details-tab-persistence); the split view stub captures its props so
// the tests observe the controlled activeTab contract, and the editor ref
// stub records the save exactly as the real BlockNoteSummaryView exposes it.

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
const errorNotify = mock((..._args: unknown[]) => {});
let splitViewProps: Record<string, any>;
// The page's editor ref, handed to the (stubbed) summary panel: each test
// installs the editor double the page will find when the tab changes.
const summaryEditorRef: { current: any } = { current: null };

function applyMocks() {
  mock.module('sonner', () => ({
    toast: { info: noopNotify, success: noopNotify, error: errorNotify, warning: noopNotify },
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
      aiSummary: null,
      meetingTitle: 'Meeting',
      blockNoteSummaryRef: summaryEditorRef,
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
      summaryStatus: 'idle',
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
// gets a fresh Map-backed stand-in (the tab-persistence suite's shim).
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const stored = new Map<string, string>();

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  noopNotify.mockClear();
  errorNotify.mockClear();
  splitViewProps = undefined as any;
  summaryEditorRef.current = null;
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

async function show() {
  await act(async () => {
    renderer = create(
      <PageContent
        meeting={{ id: 'meeting-a', title: 'Meeting', transcripts: [] }}
        summaryData={null}
        initialSummary={null}
        segments={[]}
      />,
    );
  });
}

/** An editor double matching the BlockNoteSummaryView ref API. */
function editorStub(overrides: Record<string, unknown> = {}) {
  return {
    isDirty: false,
    saveSummary: mock(async () => {}),
    getMarkdown: async () => '',
    replaceSummary: () => false,
    ...overrides,
  };
}

describe('summary autosave on tab switch', () => {
  test('leaving the summary tab with unsaved edits saves through the editor ref before the tab changes', async () => {
    await show();
    // Nothing stored: the meeting opens on the summary tab (ticket 02).
    expect(splitViewProps.activeTab).toBe('summary');

    let resolveSave!: () => void;
    const saveSummary = mock(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    summaryEditorRef.current = editorStub({ isDirty: true, saveSummary });

    await act(async () => { splitViewProps.onTabChange('transcript'); });

    // The save started, but the tab has NOT moved while it is in flight:
    // the state change that unmounts the editor waits for the save.
    expect(saveSummary).toHaveBeenCalledTimes(1);
    expect(splitViewProps.activeTab).toBe('summary');

    await act(async () => { resolveSave(); });

    expect(splitViewProps.activeTab).toBe('transcript');
    // The manual choice is still remembered globally (ticket 02 behavior).
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });

  test('leaving the summary tab without unsaved edits switches without saving', async () => {
    await show();
    expect(splitViewProps.activeTab).toBe('summary');

    const saveSummary = mock(async () => {});
    summaryEditorRef.current = editorStub({ isDirty: false, saveSummary });

    await act(async () => { splitViewProps.onTabChange('transcript'); });

    expect(saveSummary).not.toHaveBeenCalled();
    expect(splitViewProps.activeTab).toBe('transcript');
  });

  test('entering the summary tab never calls the editor save', async () => {
    stored.set(MEETING_DETAILS_ACTIVE_TAB_KEY, 'transcript');
    await show();
    expect(splitViewProps.activeTab).toBe('transcript');

    const saveSummary = mock(async () => {});
    summaryEditorRef.current = editorStub({ isDirty: true, saveSummary });

    await act(async () => { splitViewProps.onTabChange('summary'); });

    expect(saveSummary).not.toHaveBeenCalled();
    expect(splitViewProps.activeTab).toBe('summary');
  });

  test('a failed pre-switch save keeps the summary tab mounted and reports the error', async () => {
    await show();
    expect(splitViewProps.activeTab).toBe('summary');

    const saveSummary = mock(async () => { throw new Error('disk full'); });
    summaryEditorRef.current = editorStub({ isDirty: true, saveSummary });

    await act(async () => { splitViewProps.onTabChange('transcript'); });
    // Flush the rejection through the handler's catch.
    await act(async () => {});

    // No switch: the editor stays mounted with its edits intact.
    expect(splitViewProps.activeTab).toBe('summary');
    expect(errorNotify).toHaveBeenCalledTimes(1);
  });

  test('the tab choice is persisted only after the pre-switch save succeeds', async () => {
    await show();
    expect(splitViewProps.activeTab).toBe('summary');

    let resolveSave!: () => void;
    const saveSummary = mock(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    summaryEditorRef.current = editorStub({ isDirty: true, saveSummary });

    await act(async () => { splitViewProps.onTabChange('transcript'); });

    // The switch is still pending on the save: nothing is persisted yet.
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBeUndefined();

    await act(async () => { resolveSave(); });

    expect(splitViewProps.activeTab).toBe('transcript');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBe('transcript');
  });

  test('a failed pre-switch save does not persist the tab choice', async () => {
    await show();
    expect(splitViewProps.activeTab).toBe('summary');

    const saveSummary = mock(async () => { throw new Error('disk full'); });
    summaryEditorRef.current = editorStub({ isDirty: true, saveSummary });

    await act(async () => { splitViewProps.onTabChange('transcript'); });
    // Flush the rejection through the handler's catch.
    await act(async () => {});

    // The user never reached the transcript tab: the choice is not persisted.
    expect(splitViewProps.activeTab).toBe('summary');
    expect(stored.get(MEETING_DETAILS_ACTIVE_TAB_KEY)).toBeUndefined();
  });
});
