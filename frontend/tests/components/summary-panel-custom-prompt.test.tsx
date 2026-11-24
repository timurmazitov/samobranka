import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The moved custom-prompt field on the real summary panel (ticket 04): the
// textarea lives in the panel's header, next to the Generate group that
// consumes it, and keeps its old show condition — never while recording,
// only when the meeting has speech segments. The transcript panel's own
// suite-side coverage of the field is gone with the field.

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
    isSummaryDirty: false,
    summaryRef: { current: null } as any,
    isSaving: false,
    onSaveAll: async () => {},
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

function promptField(instance: ReactTestRenderer) {
  return instance.root.findAll(
    node => node.type === 'textarea' && node.props.placeholder === PROMPT_PLACEHOLDER,
  )[0];
}

/** The header block the Generate group lives in. */
function header(instance: ReactTestRenderer) {
  return instance.root.findAll(
    node => typeof node.type === 'string'
      && node.type === 'div'
      && node.props.className === 'p-4 border-b border-gray-200',
  )[0];
}

describe('summary panel custom prompt field', () => {
  test('the field shows in the header next to the Generate group when segments exist', async () => {
    const view = await render();

    const field = promptField(view);
    expect(field).toBeDefined();
    // Placement: inside the same header block as the Generate group, not at
    // the bottom of the panel and not on the transcript side.
    expect(header(view).findAll(node => node === field)).toHaveLength(1);
  });

  test('the field stays hidden while recording even with segments', async () => {
    const view = await render({ isRecording: true });

    expect(promptField(view)).toBeUndefined();
  });

  test('the field stays hidden when the meeting has no speech segments', async () => {
    const view = await render({ transcripts: [] });

    expect(promptField(view)).toBeUndefined();
  });

  test('the field shows the page-owned value and reports edits', async () => {
    const onPromptChange = mock((_value: string) => {});
    const view = await render({ customPrompt: 'participants and goals', onPromptChange });

    const field = promptField(view);
    expect(field.props.value).toBe('participants and goals');

    await act(async () => {
      field.props.onChange({ target: { value: 'focus on the decisions' } });
    });
    expect(onPromptChange).toHaveBeenCalledTimes(1);
    expect(onPromptChange).toHaveBeenCalledWith('focus on the decisions');
  });
});
