import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The summary header's Search button (ticket 04): a lucide Search button in
// the panel's top action bar that calls the page's openFind — the same
// panel the transcript header and Ctrl+F open. Rest-based like the other
// component suites: the button is found by its title and clicked.

const Container = ({ children }: any) => <div>{children}</div>;

// Bun shares module mocks across test files in a run: capture every original
// for the afterAll restore, like the panel-meeting-date suite does, so the
// command palette and dialogs of other suites keep working.
const originals = {
  tooltip: { ...(await import('../../src/components/ui/tooltip')) },
  popover: { ...(await import('../../src/components/ui/popover')) },
  dialog: { ...(await import('../../src/components/ui/dialog')) },
  dropdownMenu: { ...(await import('../../src/components/ui/dropdown-menu')) },
};

mock.module('../../src/components/ui/tooltip', () => ({
  Tooltip: Container,
  TooltipTrigger: Container,
  TooltipContent: Container,
  TooltipProvider: Container,
}));
mock.module('../../src/components/ui/popover', () => ({
  Popover: Container,
  PopoverTrigger: Container,
  PopoverContent: Container,
  PopoverAnchor: Container,
}));
mock.module('../../src/components/ui/dialog', () => ({
  Dialog: Container,
  DialogContent: Container,
  DialogTrigger: Container,
  DialogTitle: Container,
  DialogDescription: Container,
  DialogHeader: Container,
  DialogFooter: Container,
  DialogClose: Container,
  DialogPortal: Container,
}));
mock.module('../../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: Container,
  DropdownMenuContent: Container,
  DropdownMenuItem: Container,
  DropdownMenuLabel: Container,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuGroup: Container,
  DropdownMenuCheckboxItem: Container,
  DropdownMenuRadioItem: Container,
  DropdownMenuRadioGroup: Container,
}));
mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => (props: any) => <div>{props.children}</div> }),
  AnimatePresence: Container,
}));

const originalCore = { ...(await import('@tauri-apps/api/core')) };
const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meeting_summary_language') return null;
  if (command === 'api_get_meeting_speakers') return [];
  throw new Error(`Unexpected command: ${command}`);
});
// The BlockNote editor needs a real DOM; this test only asserts the header
// button, so the summary body is a stand-in (same as the panel-meeting-date
// suite). Rest-based lookups find the button, not the body.
const React = await import('react');
mock.module('../../src/components/AISummary/BlockNoteSummaryView', () => ({
  BlockNoteSummaryView: React.forwardRef(() => <div data-summary-body="true" />),
}));

mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));

afterAll(() => {
  mock.module('../../src/components/ui/tooltip', () => originals.tooltip);
  mock.module('../../src/components/ui/popover', () => originals.popover);
  mock.module('../../src/components/ui/dialog', () => originals.dialog);
  mock.module('../../src/components/ui/dropdown-menu', () => originals.dropdownMenu);
  mock.module('@tauri-apps/api/core', () => originalCore);
});

const { SummaryPanel } = await import('../../src/components/MeetingDetails/SummaryPanel');
type SummaryProps = React.ComponentProps<typeof SummaryPanel>;

function summaryProps(overrides: Partial<SummaryProps> = {}): SummaryProps {
  return {
    meeting: { id: 'meeting-a', title: 'Planning call', created_at: '2026-11-18T21:00:00+07:00' },
    meetingTitle: 'Planning call',
    isSummaryDirty: false,
    summaryRef: { current: null } as any,
    isSaving: false,
    onSaveAll: async () => {},
    onCopySummary: async () => {},
    onExportSummary: async () => {},
    // Empty-state content: the header (where the button lives) renders
    // regardless, and no BlockNote editor — its creation needs a DOM the
    // headless renderer does not provide — is mounted.
    aiSummary: null,
    summaryStatus: 'idle',
    transcripts: [],
    modelConfig: { provider: 'ollama' as any, model: 'llama', whisperModel: 'large-v3' },
    setModelConfig: () => {},
    onSaveModelConfig: async () => {},
    onGenerateSummary: async () => {},
    onStopGeneration: () => {},
    customPrompt: '',
    onPromptChange: () => {},
    onSaveSummary: async () => {},
    onSummaryChange: () => {},
    onDirtyChange: () => {},
    summaryError: null,
    onRegenerateSummary: async () => {},
    getSummaryStatusMessage: () => '',
    availableTemplates: [],
    selectedTemplate: '',
    onTemplateSelect: () => {},
    ...overrides,
  };
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
  invoke.mockClear();
  // The summary panel reads its saved language through `window`, and the
  // language hook registers a storage listener (same stub as the panel suite).
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS: { invoke },
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    },
  });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  Reflect.deleteProperty(globalThis, 'window');
});

async function render(props: Partial<SummaryProps> = {}) {
  await act(async () => {
    renderer = create(<SummaryPanel {...summaryProps(props)} />);
  });
  return renderer!;
}

function searchButton(instance: ReactTestRenderer) {
  return instance.root.findAll(
    node => node.type === 'button' && node.props.title === 'Find and replace in summary',
  )[0];
}

describe('summary panel search button', () => {
  test('the header Search button opens the find panel', async () => {
    const onOpenFind = mock(() => {});
    const view = await render({ onOpenFind });

    const button = searchButton(view);
    expect(button).toBeDefined();

    await act(async () => { button.props.onClick(); });
    expect(onOpenFind).toHaveBeenCalledTimes(1);
  });

  test('no Search button is offered without an openFind handler', async () => {
    const view = await render();
    expect(searchButton(view)).toBeUndefined();
  });
});
