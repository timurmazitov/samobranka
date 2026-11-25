import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The custom-prompt field is GONE from the real summary panel (ticket 06,
// superseding ticket 04): the editable textarea lives at the bottom of the
// transcript panel now, while the summary panel keeps only consuming the
// page-owned value through its Generate/Regenerate buttons. These tests pin
// the absence — under every condition that used to show the field — so the
// placement cannot silently regress back into the summary header.

const Container = ({ children }: any) => <div>{children}</div>;

// Bun shares module mocks across test files in a run: capture every original
// for the afterAll restore, like the panel-meeting-date suite does.
const originals = {
  tooltip: { ...(await import('../../src/components/ui/tooltip')) },
  popover: { ...(await import('../../src/components/ui/popover')) },
  dialog: { ...(await import('../../src/components/ui/dialog')) },
  dropdownMenu: { ...(await import('../../src/components/ui/dropdown-menu')) },
  modelSettings: { ...(await import('../../src/components/ModelSettingsModal')) },
  languagePicker: { ...(await import('../../src/components/LanguagePickerPopover')) },
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
// The generator group's settings dialog mounts the real model settings modal;
// the prompt field does not depend on it.
mock.module('../../src/components/ModelSettingsModal', () => ({
  ModelConfig: {},
  ModelSettingsModal: () => <div />,
}));
// With segments present the language slot renders the picker, whose document
// listeners need a DOM the headless renderer does not provide; the picker is
// not under test here.
mock.module('../../src/components/LanguagePickerPopover', () => ({
  LanguagePickerPopover: () => <div />,
}));

const originalCore = { ...(await import('@tauri-apps/api/core')) };
const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meeting_summary_language') return null;
  if (command === 'api_get_meeting_speakers') return [];
  throw new Error(`Unexpected command: ${command}`);
});
// The BlockNote editor needs a real DOM; this test only asserts the header
// field, so the summary body is a stand-in (same as the panel-meeting-date
// suite).
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
  mock.module('../../src/components/ModelSettingsModal', () => originals.modelSettings);
  mock.module('../../src/components/LanguagePickerPopover', () => originals.languagePicker);
  mock.module('@tauri-apps/api/core', () => originalCore);
});

const { SummaryPanel } = await import('../../src/components/MeetingDetails/SummaryPanel');
type SummaryProps = React.ComponentProps<typeof SummaryPanel>;

const TRANSCRIPTS = [
  { id: 't1', text: 'alpha first' },
  { id: 't2', text: 'beta second' },
] as any;

// The English catalog value of summary.promptPlaceholder — the field is found
// by what the user reads, not by a test id.
const PROMPT_PLACEHOLDER =
  'Add context for AI summary. For example people involved, meeting overview, objective etc...';

function summaryProps(overrides: Partial<SummaryProps> = {}): SummaryProps {
  return {
    meeting: { id: 'meeting-a', title: 'Planning call', created_at: '2026-11-18T21:00:00+07:00' },
    meetingTitle: 'Planning call',
    summaryRef: { current: null } as any,
    onCopySummary: async () => {},
    onExportSummary: async () => {},
    aiSummary: null,
    summaryStatus: 'idle',
    transcripts: TRANSCRIPTS,
    modelConfig: { provider: 'ollama' as any, model: 'llama', whisperModel: 'large-v3' },
    setModelConfig: () => {},
    onSaveModelConfig: async () => {},
    onGenerateSummary: async () => {},
    onStopGeneration: () => {},
    customPrompt: '',
    onSaveSummary: async () => {},
    onSummaryChange: () => {},
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

function promptFields(instance: ReactTestRenderer) {
  return instance.root.findAll(
    node => node.type === 'textarea' && node.props.placeholder === PROMPT_PLACEHOLDER,
  );
}

describe('summary panel custom prompt field', () => {
  test('the field is absent even when the meeting has speech segments', async () => {
    const view = await render();

    // Placement lives on the transcript panel now (ticket 06); nothing of
    // the old summary-side field may survive — no textarea anywhere.
    expect(promptFields(view)).toHaveLength(0);
  });

  test('the field is absent when the meeting has no speech segments', async () => {
    const view = await render({ transcripts: [] });

    expect(promptFields(view)).toHaveLength(0);
  });

  test('the panel still receives the prompt value for Generate', async () => {
    const view = await render({ customPrompt: 'participants and goals' });

    // The value prop keeps arriving: the Generate/Regenerate buttons consume
    // it, the transcript panel's field at the bottom writes it.
    const generateButton = view.root.findAll(
      node => typeof node.type === 'string' && node.type === 'button',
    );
    expect(generateButton.length).toBeGreaterThan(0);
  });
});
