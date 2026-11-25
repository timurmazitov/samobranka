import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for the custom-prompt placement (ticket 06, superseding
// ticket 04): the prompt text state stays on the meeting page. The editable
// field lives at the BOTTOM of the transcript panel (visible in transcript
// mode, gone in summary mode with the panel), while the summary panel keeps
// receiving the value — its Generate/Regenerate buttons consume it. The
// heavy panels and data hooks are stand-ins (the same harness as
// meeting-details-mode-exclusivity), so the routing is observed through the
// props each panel stub receives: the transcript stub gets the value and the
// change handler, the summary stub keeps only the value, and the generate
// consumer is wired exactly as before.

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

const infoNotify = mock((..._args: unknown[]) => {});
const generateSummary = mock(async (..._args: unknown[]) => {});
let panelProps: Record<string, any>;
let summaryPanelProps: Record<string, any>;

function applyMocks() {
  mock.module('sonner', () => ({
    toast: { info: infoNotify, success: infoNotify, error: infoNotify, warning: infoNotify },
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
    useSidebar: () => ({ serverAddress: '' }),
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
    MeetingDetailsSplitView: ({ transcript, summary }: any) => (
      <div>{transcript}{summary}</div>
    ),
  }));
  mock.module('../../src/components/ModelSettingsModal', () => ({ ModelConfig: {} }));
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => ({
    useMeetingData: () => ({
      transcripts: [],
      aiSummary: null,
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
      summaryStatus: 'idle',
      handleRegenerateSummary: async () => {},
      handleGenerateSummary: generateSummary,
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

const SEGMENTS = [
  { id: 't1', timestamp: 0, text: 'alpha first' },
  { id: 't2', timestamp: 1, text: 'beta second' },
];

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  infoNotify.mockClear();
  generateSummary.mockClear();
  panelProps = undefined as any;
  summaryPanelProps = undefined as any;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function show(props: Record<string, unknown> = {}) {
  await act(async () => {
    renderer = create(
      <PageContent
        meeting={{ id: 'meeting-a', title: 'Meeting', transcripts: [] }}
        summaryData={null}
        initialSummary={null}
        segments={SEGMENTS}
        {...props}
      />,
    );
  });
}

describe('custom prompt field placement on the meeting page', () => {
  test('the transcript panel receives the prompt value and change handler', async () => {
    await show();

    expect(panelProps.customPrompt).toBe('');
    expect(typeof panelProps.onPromptChange).toBe('function');
  });

  test('the summary panel keeps the value for Generate but gets no field props', async () => {
    await show();

    // The summary side still consumes the prompt (Generate/Regenerate), so
    // the value keeps arriving; the editable field itself lives on the
    // transcript panel, and the recording guard left with it.
    expect(summaryPanelProps.customPrompt).toBe('');
    expect(summaryPanelProps.onPromptChange).toBeUndefined();
    expect(summaryPanelProps.isRecording).toBeUndefined();
  });

  test('typed text round-trips through the page state to both panels', async () => {
    await show();

    await act(async () => {
      panelProps.onPromptChange('focus on the decisions');
    });

    expect(panelProps.customPrompt).toBe('focus on the decisions');
    // Generate on the summary side reads the same page-owned state.
    expect(summaryPanelProps.customPrompt).toBe('focus on the decisions');
  });

  test('the generate consumer is wired to the same value as before', async () => {
    await show();

    // The page still hands the summary panel the generation hook's own
    // handler; the panel's Generate/Regenerate buttons consume the prompt
    // from the page state the transcript panel's field writes to.
    expect(summaryPanelProps.onGenerateSummary).toBe(generateSummary);

    await act(async () => {
      panelProps.onPromptChange('participants and goals');
    });
    expect(summaryPanelProps.customPrompt).toBe('participants and goals');
    expect(summaryPanelProps.onGenerateSummary).toBe(generateSummary);
  });
});
