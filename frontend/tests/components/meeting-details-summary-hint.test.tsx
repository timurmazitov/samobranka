import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Page-level seam for the regenerate-summary hint: after the meeting page's
// transcript panel reports a successfully saved row edit, the page-content
// shell surfaces a single toast offering the existing regenerate action.
// The heavy panels and data hooks around it are stand-ins here; the behavior
// under test is what page-content does with the save callback, observed
// through the captured TranscriptPanel props and the mocked sonner.

const Container = ({ children }: any) => <div>{children}</div>;

// Bun shares module mocks across test files in a run: capture every original
// so this suite restores them in afterAll, and re-apply its own mocks in
// beforeEach in case another suite restored a real module mid-run (the same
// defense the transcript row suites use for the Tauri core).
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
const regenerate = mock(async () => {});
let summaryStatus = 'idle';
// The transcript panel stands in for the whole row chain: it records the
// props so a test can report a saved edit exactly as the row would.
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
  // The data hooks are stand-ins; only summaryStatus and the regenerate
  // callback feed the hint. The status is read through a getter so a test can
  // change it between renders without re-mocking.
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
      get summaryStatus() { return summaryStatus; },
      handleRegenerateSummary: () => regenerate(),
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

// Catalog import initializes i18next (English default) for the toast strings.
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

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  applyMocks();
  infoNotify.mockClear();
  regenerate.mockClear();
  summaryStatus = 'idle';
  panelProps = undefined as any;
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
        segments={[]}
        {...props}
      />,
    );
  });
}

/** Report a saved row edit the way the row does: after the backend call won. */
async function saveEdit(id: string, text: string) {
  await act(async () => { await panelProps.onTextEdited(id, text); });
}

/** Report a deleted segment the way the row does: after the delete resolved. */
async function deleteSegment(id: string) {
  await act(async () => { await panelProps.onSegmentDeleted(id); });
}

describe('regenerate-summary hint on the meeting page', () => {
  test('a saved edit while a completed summary exists offers regeneration', async () => {
    summaryStatus = 'completed';
    await show();

    await saveEdit('t1', 'Fixed words');

    expect(infoNotify).toHaveBeenCalledTimes(1);
    const [message, options] = infoNotify.mock.calls[0] as [string, Record<string, any>];
    expect(message).toBe('The summary no longer matches your edited transcript.');
    expect(options.action.label).toBe('Regenerate Summary');

    await act(async () => { options.action.onClick(); });
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  test('a saved edit with no summary shows no hint', async () => {
    await show();

    await saveEdit('t1', 'Fixed words');

    expect(infoNotify).not.toHaveBeenCalled();
    expect(regenerate).not.toHaveBeenCalled();
  });

  test('an edit the host could not apply shows no hint', async () => {
    summaryStatus = 'completed';
    // The row reports a failed backend save by never reaching this callback,
    // but a host failure here must not claim the summary is stale either.
    let thrown: unknown = null;
    await show({ onTextEdited: async () => { throw new Error('database is locked'); } });

    await act(async () => {
      try { await panelProps.onTextEdited('t1', 'Never stored'); }
      catch (error) { thrown = error; }
    });

    // The failure keeps propagating to the row (its rollback path), and no
    // stale-summary hint appears for an edit that was not applied.
    expect(String(thrown)).toContain('database is locked');
    expect(infoNotify).not.toHaveBeenCalled();
  });

  // Ticket 01: a single delete makes the summary stale through the very same
  // hint chain an edit uses (the bulk toolbar of ticket 05 reuses it), and a
  // rejected delete must neither claim staleness nor swallow the error the
  // row toasts on.
  test('a deleted segment while a completed summary exists offers regeneration', async () => {
    summaryStatus = 'completed';
    const deleted = mock(async (_id: string) => {});
    await show({ onSegmentDeleted: deleted });

    await deleteSegment('t1');

    expect(deleted).toHaveBeenCalledWith('t1');
    expect(infoNotify).toHaveBeenCalledTimes(1);
    const [message, options] = infoNotify.mock.calls[0] as [string, Record<string, any>];
    expect(message).toBe('The summary no longer matches your edited transcript.');
    expect(options.action.label).toBe('Regenerate Summary');
  });

  test('a rejected delete shows no hint and keeps propagating to the row', async () => {
    summaryStatus = 'completed';
    let thrown: unknown = null;
    await show({ onSegmentDeleted: async () => { throw new Error('transcript not found: t1'); } });

    await act(async () => {
      try { await panelProps.onSegmentDeleted('t1'); }
      catch (error) { thrown = error; }
    });

    expect(String(thrown)).toContain('transcript not found');
    expect(infoNotify).not.toHaveBeenCalled();
  });

  // Ticket 01 gates: the delete availability mirrors the edit gates plus the
  // retranscription, and both booleans reach the view through the panel.
  test('the panel receives the diarization and retranscription delete gates', async () => {
    await show();

    expect(panelProps.isDiarizing).toBe(false);
    expect(panelProps.isRetranscribing).toBe(false);
  });

  // The delete button's data: the page hands the panel a working callback
  // built on the pagination hook's batch delete, so the live page never
  // shows a trash that deletes nothing.
  test('the panel receives the delete callback the page wires to the hook', async () => {
    await show();
    expect(typeof panelProps.onSegmentDeleted).toBe('function');
  });

  // Ticket 03: replacements go through this same save callback, so the hint
  // chain the row already uses must keep working after «Заменить» and
  // «Заменить все». The panel is rendered for real here; the save path is
  // what the page hands the find hook, so this drives the page's own wiring.
  test('a find-panel replacement shows the same regenerate hint once', async () => {
    summaryStatus = 'completed';
    await show({
      segments: [
        { id: 't1', timestamp: 0, text: 'alpha first' },
        { id: 't2', timestamp: 1, text: 'alpha second, alpha third' },
      ],
      // Stands in for the pagination hook's save: resolves like a stored edit.
      onTextEdited: async (_id: string, _text: string) => {},
    });

    // Open the panel the way the header's search button does, type the query,
    // then press «Replace all» as rendered by the real panel.
    await act(async () => { panelProps.onOpenFind(); });
    const search = renderer!.root.findAll(n => n.type === 'input' && n.props.placeholder === 'Search')[0];
    await act(async () => { search.props.onChange({ target: { value: 'alpha' } }); });
    const replaceAllButton = renderer!.root.findAll(
      n => n.type === 'button' && String(n.props.children ?? '').includes('Replace all'),
    )[0];
    expect(replaceAllButton).toBeDefined();

    await act(async () => { replaceAllButton.props.onClick(); });

    // One hint for the whole bulk action: the save path notifies per saved
    // segment, but the id-stable sonner toast replaces instead of stacking,
    // so the user sees one current hint — the same guarantee consecutive row
    // edits already have.
    expect(infoNotify.mock.calls.length).toBeGreaterThan(0);
    const ids = new Set(infoNotify.mock.calls.map(call => (call[1] as Record<string, unknown>).id));
    expect(ids.size).toBe(1);
    const [message, options] = infoNotify.mock.calls[0] as [string, Record<string, any>];
    expect(message).toBe('The summary no longer matches your edited transcript.');
    expect(options.action.label).toBe('Regenerate Summary');
  });
});
