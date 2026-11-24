import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for mode exclusivity (ticket 04): the meeting page owns
// both the selection mode (useTranscriptSelection) and the find panel
// (useFindReplace), so it is where the two directions of exclusivity live —
// entering the mode closes the panel, and opening the panel (button or the
// Ctrl+F/H hotkey) leaves the mode and clears the ids. The heavy panels and
// data hooks are stand-ins (the same harness as meeting-details-summary-hint);
// the real FindReplacePanel stays mounted so "panel open" is observable.

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
let panelProps: Record<string, any>;

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
    SummaryPanel: () => <div />,
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

const SEGMENTS = [
  { id: 't1', timestamp: 0, text: 'alpha first' },
  { id: 't2', timestamp: 1, text: 'beta second' },
];

// The page hotkeys register on a real DOM only; bun has none, so the
// hotkey-driven test provides the EventTarget document the page listens on
// (the same stand-in the route tests use).
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  infoNotify.mockClear();
  panelProps = undefined as any;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
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

function findInput(instance: ReactTestRenderer) {
  return instance.root.findAll(
    n => n.type === 'input' && n.props.placeholder === 'Search',
  )[0];
}

async function openFind(instance: ReactTestRenderer) {
  await act(async () => { panelProps.onOpenFind(); });
  expect(findInput(instance)).toBeDefined();
}

async function enterMode(instance: ReactTestRenderer, ...ids: string[]) {
  await act(async () => { panelProps.onToggleSelection(); });
  expect(panelProps.selectionMode).toBe(true);
  for (const id of ids) {
    await act(async () => { panelProps.onToggleSelected(id); });
  }
}

describe('mode exclusivity on the meeting page', () => {
  test('entering selection mode closes the open find panel', async () => {
    await show();
    await openFind(renderer!);

    await enterMode(renderer!);

    expect(panelProps.selectionMode).toBe(true);
    expect(findInput(renderer!)).toBeUndefined();
  });

  test('opening find from selection mode exits the mode and clears the selection', async () => {
    await show();
    await enterMode(renderer!, 't1', 't2');

    await openFind(renderer!);

    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
    // The panel really opened: the modes traded places, not both closed.
    expect(findInput(renderer!)).toBeDefined();
  });

  test('the summary panel find button also exits selection mode', async () => {
    await show();
    await enterMode(renderer!, 't1');

    // The summary panel opens find through its own button, wired to the same
    // page-level entry point.
    await act(async () => { panelProps.onOpenFind(); });

    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
  });

  test('the Ctrl+F hotkey path exits selection mode and opens the panel', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new EventTarget(),
    });
    await show();
    await enterMode(renderer!, 't1');

    await act(async () => {
      const event = new Event('keydown', { cancelable: true });
      Object.assign(event, { key: 'f', code: 'KeyF', ctrlKey: true, altKey: false });
      globalThis.document!.dispatchEvent(event);
    });

    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
    expect(findInput(renderer!)).toBeDefined();
  });

  test('the Ctrl+H hotkey path exits selection mode too', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: new EventTarget(),
    });
    await show();
    await enterMode(renderer!, 't1');

    await act(async () => {
      const event = new Event('keydown', { cancelable: true });
      Object.assign(event, { key: 'h', code: 'KeyH', ctrlKey: true, altKey: false });
      globalThis.document!.dispatchEvent(event);
    });

    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
    expect(findInput(renderer!)).toBeDefined();
  });

  test('the panel receives the pencil exit-selection callback', async () => {
    await show();
    expect(typeof panelProps.onExitSelection).toBe('function');
  });

  test('a pencil-driven exit from selection mode leaves find closed and the mode off', async () => {
    await show();
    await enterMode(renderer!, 't1');

    await act(async () => { panelProps.onExitSelection(); });

    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
    expect(findInput(renderer!)).toBeUndefined();
  });

  test('toggling the mode off then on again starts fresh with the panel closed', async () => {
    await show();
    await enterMode(renderer!, 't1');
    await act(async () => { panelProps.onToggleSelection(); });
    expect(panelProps.selectionMode).toBe(false);

    await openFind(renderer!);
    await enterMode(renderer!, 't2');

    expect(panelProps.selectionMode).toBe(true);
    expect(panelProps.selectedIds).toEqual(['t2']);
    expect(findInput(renderer!)).toBeUndefined();
  });
});
