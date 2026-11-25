import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The summary panel's autosave and the removed Save button (meeting-view-toggle,
// ticket 03): losing focus from the BlockNote editor persists unsaved edits
// through the same editor ref API the old Save button used, and only when the
// editor is dirty; the panel itself no longer offers a Save button or a dirty
// highlight — Copy and Export stay. The real panel is rendered with the
// BlockNote body stubbed by an editor double exposing the ref API (the same
// harness as summary-panel-search-button), so the tests drive the blur the
// way the DOM would and observe the ref calls.

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
  sonner: { ...(await import('sonner')) },
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
// The generator group's settings dialog mounts the real model settings modal,
// which needs the config provider; the autosave does not depend on it.
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

const errorNotify = mock((..._args: unknown[]) => {});
mock.module('sonner', () => ({
  toast: { info: errorNotify, success: errorNotify, error: errorNotify, warning: errorNotify },
}));

const originalCore = { ...(await import('@tauri-apps/api/core')) };
const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meeting_summary_language') return null;
  if (command === 'api_get_meeting_speakers') return [];
  throw new Error(`Unexpected command: ${command}`);
});
// The BlockNote editor needs a real DOM; the summary body is an editor double
// that exposes the ref API (saveSummary/isDirty) exactly like the real
// BlockNoteSummaryView, so the blur path is observed through the ref.
const React = await import('react');
let editorStub: Record<string, any> | null = null;
mock.module('../../src/components/AISummary/BlockNoteSummaryView', () => ({
  BlockNoteSummaryView: React.forwardRef((props: any, ref: any) => {
    React.useImperativeHandle(ref, () => editorStub);
    return <div data-summary-body="true" />;
  }),
}));

mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));

afterAll(() => {
  mock.module('../../src/components/ui/tooltip', () => originals.tooltip);
  mock.module('../../src/components/ui/popover', () => originals.popover);
  mock.module('../../src/components/ui/dialog', () => originals.dialog);
  mock.module('../../src/components/ui/dropdown-menu', () => originals.dropdownMenu);
  mock.module('../../src/components/ModelSettingsModal', () => originals.modelSettings);
  mock.module('../../src/components/LanguagePickerPopover', () => originals.languagePicker);
  mock.module('sonner', () => originals.sonner);
  mock.module('@tauri-apps/api/core', () => originalCore);
});

const { SummaryPanel } = await import('../../src/components/MeetingDetails/SummaryPanel');
type SummaryProps = React.ComponentProps<typeof SummaryPanel>;

const TRANSCRIPTS = [
  { id: 't1', text: 'alpha first' },
  { id: 't2', text: 'beta second' },
] as any;

// Visible content, so the panel renders the editor branch (and the updater
// button group) instead of the empty state.
const AI_SUMMARY = {
  summary_json: [
    { id: 'b1', type: 'paragraph', content: [{ type: 'text', text: 'saved text', styles: {} }] },
  ],
} as any;

function summaryProps(overrides: Partial<SummaryProps> = {}): SummaryProps {
  return {
    meeting: { id: 'meeting-a', title: 'Planning call', created_at: '2026-11-18T21:00:00+07:00' },
    meetingTitle: 'Planning call',
    summaryRef: { current: null } as any,
    onCopySummary: async () => {},
    onExportSummary: async () => {},
    aiSummary: AI_SUMMARY,
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
  errorNotify.mockClear();
  editorStub = null;
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

/** The scroll container wrapping the summary editor — the blur boundary. */
function editorContainer(instance: ReactTestRenderer) {
  return instance.root.findAll(
    node => typeof node.type === 'string'
      && node.type === 'div'
      && node.props.className === 'flex-1 overflow-y-auto overflow-x-auto min-h-0 p-6',
  )[0];
}

function buttonByTitle(instance: ReactTestRenderer, title: string) {
  return instance.root.findAll(
    node => node.type === 'button' && node.props.title === title,
  )[0];
}

/** An editor double matching the BlockNoteSummaryView ref API. */
function installEditor(overrides: Record<string, unknown> = {}) {
  editorStub = {
    isDirty: false,
    saveSummary: mock(async () => {}),
    getMarkdown: async () => '',
    replaceSummary: () => false,
    ...overrides,
  };
  return editorStub;
}

describe('summary panel blur autosave', () => {
  test('losing focus with unsaved edits saves through the editor ref', async () => {
    const editor = installEditor({ isDirty: true });
    const view = await render();

    const container = editorContainer(view);
    expect(container).toBeDefined();
    expect(typeof container.props.onBlur).toBe('function');

    await act(async () => { container.props.onBlur(); });

    expect(editor.saveSummary).toHaveBeenCalledTimes(1);
  });

  test('losing focus without unsaved edits does not call the save', async () => {
    const editor = installEditor({ isDirty: false });
    const view = await render();

    await act(async () => { editorContainer(view).props.onBlur(); });

    expect(editor.saveSummary).not.toHaveBeenCalled();
  });

  test('a failed blur save reports the error', async () => {
    installEditor({ isDirty: true, saveSummary: mock(async () => { throw new Error('disk full'); }) });
    const view = await render();

    await act(async () => { editorContainer(view).props.onBlur(); });
    // Flush the rejection through the handler's catch.
    await act(async () => {});

    expect(errorNotify).toHaveBeenCalledTimes(1);
  });
});

describe('summary panel without the Save button', () => {
  test('no Save button or dirty highlight remains; Copy and Export stay', async () => {
    installEditor({ isDirty: true });
    const view = await render();

    // The English catalog values of summary.updater.saveTitle / copyTitle /
    // exportTitle — the buttons are found by what the user reads.
    expect(buttonByTitle(view, 'Save Changes')).toBeUndefined();
    expect(buttonByTitle(view, 'Copy Summary')).toBeDefined();
    expect(buttonByTitle(view, 'Export Summary')).toBeDefined();
    // The dirty highlight lived on the Save button; nothing green remains.
    const highlighted = view.root.findAll(
      node => typeof node.props?.className === 'string' && node.props.className.includes('bg-green-200'),
    );
    expect(highlighted).toHaveLength(0);
  });
});
