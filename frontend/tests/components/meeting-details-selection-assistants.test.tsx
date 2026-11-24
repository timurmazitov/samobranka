import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for ticket 03: the meeting page owns the selection
// assistants (the page passes them down through the transcript panel) and
// extends the page's SINGLE document keydown listener with the selection
// keys — Escape exits the mode (claiming the event so the find panel never
// sees it), Delete fires the same bulk-delete path as the «Удалить (N)»
// button. The heavy panels and data hooks are the same stand-ins as
// meeting-details-summary-hint.test.tsx; the real page-content,
// useTranscriptSelection and useFindReplace stay in play.

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
// Captured props of the stubbed surfaces: the transcript panel feeds the
// assistants, the find panel reports whether it is open.
let panelProps: Record<string, any>;
let findPanelProps: Record<string, any>;

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
    SummaryPanel: () => <div />,
  }));
  mock.module('../../src/components/MeetingDetails/MeetingDetailsSplitView', () => ({
    MeetingDetailsSplitView: ({ transcript, summary }: any) => (
      <div>{transcript}{summary}</div>
    ),
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
  mock.module('../../src/components/ModelSettingsModal', () => originalModelSettings);
  mock.module('../../src/components/MeetingDetails/FindReplacePanel', () => originalFindReplacePanel);
  mock.module('../../src/hooks/meeting-details/useMeetingData', () => originalUseMeetingData);
  mock.module('../../src/hooks/meeting-details/useSummaryGeneration', () => originalUseSummaryGeneration);
  mock.module('../../src/hooks/meeting-details/useTemplates', () => originalUseTemplates);
  mock.module('../../src/hooks/meeting-details/useCopyOperations', () => originalUseCopyOperations);
  mock.module('../../src/hooks/meeting-details/useMeetingOperations', () => originalUseMeetingOperations);
  uninstallFakeDocument();
});

// The page registers its single keydown listener only on a real DOM, so the
// suite installs a minimal fake document that records the listeners. It is
// installed per test and removed right after (bun loads every test file's
// module body before running any test: a module-scoped global would leak
// into other suites' module bodies, and a leftover would leak after this one).
type FakeKeyboardEvent = {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target?: { tagName?: string; isContentEditable?: boolean };
  preventDefault: () => void;
};
let keydownListeners: Array<(event: FakeKeyboardEvent) => void> = [];
function installFakeDocument() {
  keydownListeners = [];
  (globalThis as any).document = {
    addEventListener: (type: string, listener: (event: FakeKeyboardEvent) => void) => {
      if (type === 'keydown') keydownListeners.push(listener);
    },
    removeEventListener: (type: string, listener: (event: FakeKeyboardEvent) => void) => {
      if (type === 'keydown') {
        const index = keydownListeners.indexOf(listener);
        if (index >= 0) keydownListeners.splice(index, 1);
      }
    },
  };
}
function uninstallFakeDocument() {
  delete (globalThis as any).document;
  keydownListeners = [];
}

function pressKey(init: Partial<FakeKeyboardEvent>): FakeKeyboardEvent {
  const event: FakeKeyboardEvent = {
    key: '',
    code: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault: () => { event.defaultPrevented = true; },
    ...init,
  };
  // A snapshot: a listener registered during dispatch must not run here.
  for (const listener of [...keydownListeners]) listener(event);
  return event;
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  noopNotify.mockClear();
  panelProps = undefined as any;
  findPanelProps = undefined as any;
  // Fresh listener registry per test; the page mounts (and registers) only
  // once show() runs inside the test body.
  installFakeDocument();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  // The page's cleanup removes its listener; drop the fake document either
  // way so no other suite ever sees it.
  expect(keydownListeners).toHaveLength(0); // leftovers mean a leaky unmount
  uninstallFakeDocument();
});

const SEGMENTS = [
  { id: 't1', timestamp: 0, text: 'first', speaker: 'speaker_0' },
  { id: 't2', timestamp: 1, text: 'second', speaker: 'speaker_1' },
  { id: 't3', timestamp: 2, text: 'third', speaker: 'speaker_0' },
];

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

describe('selection assistants on the meeting page', () => {
  test('«select all visible» marks the loaded rows, a re-press clears them', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });

    await act(async () => { panelProps.onSelectAllVisible(); });
    expect(panelProps.selectedIds).toEqual(['t1', 't2', 't3']);

    // Re-press over a fully-marked list clears it (the toggle's contract).
    await act(async () => { panelProps.onSelectAllVisible(); });
    expect(panelProps.selectedIds).toEqual([]);
  });

  test('«select all visible» covers only the loaded window', async () => {
    // page.tsx hands the page the pagination hook's loaded segments — the
    // totalCount above the loaded window must NOT leak into the selection
    // («Удалить (N)» counts what delete can actually delete).
    await show({ totalCount: 250, loadedCount: 3 });
    await act(async () => { panelProps.onToggleSelection(); });

    await act(async () => { panelProps.onSelectAllVisible(); });

    expect(panelProps.selectedIds).toEqual(['t1', 't2', 't3']);
  });

  test('by-speaker selects the loaded segments carrying the diarization label', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });

    // Not segment_count (the panel counts the whole meeting): only the
    // loaded rows whose speaker field carries the label.
    await act(async () => { panelProps.onSelectBySpeaker('speaker_0'); });
    expect(panelProps.selectedIds).toEqual(['t1', 't3']);

    await act(async () => { panelProps.onSelectBySpeaker('speaker_1'); });
    expect(panelProps.selectedIds).toEqual(['t2']);
  });

  test('shift-click asks the host for the range from the last selected row', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });
    await act(async () => { panelProps.onToggleSelected('t1'); });

    await act(async () => { panelProps.onRowRangeSelect('t3', { shift: true }); });

    // Range from the anchor (t1) to t3 in loaded order, inclusive.
    expect(panelProps.selectedIds).toEqual(['t1', 't2', 't3']);
  });
});

describe('selection keyboard on the page listener', () => {
  test('Escape exits the selection mode and claims the event from the find panel', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });
    await act(async () => { panelProps.onToggleSelected('t1'); });

    const event = pressKey({ key: 'Escape' });

    expect(event.defaultPrevented).toBe(true);
    expect(panelProps.selectionMode).toBe(false);
    expect(panelProps.selectedIds).toEqual([]);
    // The find panel stayed shut: the claimed Escape never reached its closer.
    expect(findPanelProps.open).toBe(false);
  });

  test('Escape outside the mode still closes the find panel', async () => {
    await show();
    await act(async () => { panelProps.onOpenFind(); });
    expect(findPanelProps.open).toBe(true);

    const event = pressKey({ key: 'Escape' });

    expect(event.defaultPrevented).toBe(false);
    expect(findPanelProps.open).toBe(false);
  });

  test('Delete bumps the view delete request so the button path confirms', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });
    await act(async () => { panelProps.onToggleSelected('t1'); });
    await act(async () => { panelProps.onToggleSelected('t2'); });
    const before = panelProps.bulkDeleteNonce;

    const event = pressKey({ key: 'Delete' });

    expect(event.defaultPrevented).toBe(true);
    expect(panelProps.bulkDeleteNonce).toBe(before + 1);
  });

  test('Delete does nothing outside the mode, with nothing selected, or while typing', async () => {
    // Outside the mode.
    await show();
    expect(panelProps.bulkDeleteNonce).toBe(0);
    pressKey({ key: 'Delete' });
    expect(panelProps.bulkDeleteNonce).toBe(0);

    // Inside the mode but nothing selected.
    await act(async () => { panelProps.onToggleSelection(); });
    pressKey({ key: 'Delete' });
    expect(panelProps.bulkDeleteNonce).toBe(0);

    // A focused text field owns Delete (the inline editor, the find inputs).
    await act(async () => { panelProps.onToggleSelected('t1'); });
    pressKey({ key: 'Delete', target: { tagName: 'TEXTAREA' } });
    pressKey({ key: 'Delete', target: { tagName: 'INPUT' } });
    pressKey({ key: 'Delete', target: { isContentEditable: true } });
    expect(panelProps.bulkDeleteNonce).toBe(0);
  });

  test('Backspace is not the selection delete key: the spec names Delete only', async () => {
    await show();
    await act(async () => { panelProps.onToggleSelection(); });
    await act(async () => { panelProps.onToggleSelected('t1'); });
    expect(panelProps.bulkDeleteNonce).toBe(0);

    const event = pressKey({ key: 'Backspace' });

    // The page claims Delete exclusively; Backspace stays a text-editing and
    // browser-undo key and must not trigger the bulk delete confirmation.
    expect(event.defaultPrevented).toBe(false);
    expect(panelProps.bulkDeleteNonce).toBe(0);
  });

  test('the Ctrl+F hotkey still opens the find panel with the selection keys added', async () => {
    await show();

    const event = pressKey({ key: 'f', code: 'KeyF', ctrlKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(findPanelProps.open).toBe(true);
  });
});
