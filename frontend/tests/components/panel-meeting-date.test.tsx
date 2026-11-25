import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Both panels sit inside Radix portals (tooltips, popovers, dialogs, dropdowns)
// and framer-motion wrappers that need a real DOM. These tests only assert the
// header text, so the wrappers become plain containers. Restored in `afterAll`
// where bun's shared module mocks allow it.
const Container = ({ children }: any) => <div>{children}</div>;

const originals = {
  tooltip: { ...(await import('../../src/components/ui/tooltip')) },
  popover: { ...(await import('../../src/components/ui/popover')) },
  dialog: { ...(await import('../../src/components/ui/dialog')) },
  dropdownMenu: { ...(await import('../../src/components/ui/dropdown-menu')) },
  config: { ...(await import('../../src/contexts/ConfigContext')) },
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

afterAll(() => {
  mock.module('../../src/components/ui/tooltip', () => originals.tooltip);
  mock.module('../../src/components/ui/popover', () => originals.popover);
  mock.module('../../src/components/ui/dialog', () => originals.dialog);
  mock.module('../../src/components/ui/dropdown-menu', () => originals.dropdownMenu);
  mock.module('../../src/contexts/ConfigContext', () => originals.config);
});

// The retranscribe dialog inside the transcript button group reads the config
// context on mount; only the config edge is stubbed, the rest stays real.
mock.module('../../src/contexts/ConfigContext', () => ({
  ...originals.config,
  useConfig: () => ({
    selectedLanguage: 'auto',
    transcriptModelConfig: { provider: 'whisper', model: 'large-v3' },
  }),
}));

// framer-motion cannot detect SVG elements without a DOM. Like the existing
// component suites, this mock stays installed for the process: restoring it in
// `afterAll` would break the other suites that loaded their components already.
const motionContainer = (props: any) => <div>{props.children}</div>;
mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => motionContainer }),
  AnimatePresence: Container,
}));

// The panels talk to Tauri only for unrelated side channels (summary language,
// speakers). The fake backend keeps those quiet and never touches the date.
const originalCore = { ...(await import('@tauri-apps/api/core')) };
const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meeting_summary_language') return null;
  if (command === 'api_get_meeting_speakers') return [];
  throw new Error(`Unexpected command: ${command}`);
});
const coreMock = () => ({ ...originalCore, invoke });
mock.module('@tauri-apps/api/core', coreMock);

const notify = mock(() => {});
mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));

// The summary body is BlockNote, which needs a real DOM; this suite only cares
// where the date sits, so the editor is replaced by a plain marker.
mock.module('../../src/components/AISummary/BlockNoteSummaryView', () => ({
  BlockNoteSummaryView: React.forwardRef(() => <div data-summary-body="true" />),
}));

const stored = new Map<string, string>();

beforeEach(() => {
  mock.module('@tauri-apps/api/core', coreMock);
  // Radix (tabs) schedules a mount animation on the bare global.
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => { callback(); return 0; },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
  // The summary panel reads its saved language preference through `window`;
  // the language picker registers a `storage` listener.
  (globalThis as any).window = {
    __TAURI_INTERNALS: { invoke },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    // Kept for any consumer that probes media queries; the split view no
    // longer branches on viewport width.
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
  };
  invoke.mockClear();
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  stored.clear();
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

const { SummaryPanel } = await import('../../src/components/MeetingDetails/SummaryPanel');
const { TranscriptPanel } = await import('../../src/components/MeetingDetails/TranscriptPanel');

/** Local moment, so the rendered text does not depend on the test machine's zone. */
const meetingDate = new Date(2026, 10, 18, 14, 32).toISOString();
const expectedDate = '18/11/2026, 14:32';

type SummaryProps = React.ComponentProps<typeof SummaryPanel>;
type TranscriptProps = React.ComponentProps<typeof TranscriptPanel>;

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

function transcriptProps(overrides: Partial<TranscriptProps> = {}): TranscriptProps {
  return {
    transcripts: [],
    onCopyTranscript: () => {},
    onExportTranscript: () => {},
    onOpenMeetingFolder: async () => {},
    isRecording: false,
    meetingId: 'meeting-a',
    meetingFolderPath: '/tmp/meeting-a',
    ...overrides,
  };
}

async function render(element: React.ReactElement) {
  await act(async () => {
    renderer = create(element);
  });
  return renderer!;
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node?.children) return node.children.map(textOf).join('');
  return '';
}

function viewText(instance: ReactTestRenderer): string {
  return textOf(instance.toJSON());
}

/** The header's action rows: the date line is a sibling of the centered buttons. */
function headerRows(instance: ReactTestRenderer, containerClass: string) {
  const root = instance.root.find(
    (node) => typeof node.type === 'string' && node.props.className === containerClass,
  );
  const header = root
    .findAll((node) => typeof node.type === 'string' && node.props.className === 'p-4 border-b border-gray-200')
    .at(0);
  expect(header).toBeDefined();
  return (header!.children as any[]).filter((child) => typeof child !== 'string');
}

/** The right-aligned date rows currently rendered in a panel header. */
function dateRows(instance: ReactTestRenderer, containerClass: string) {
  return headerRows(instance, containerClass).filter((row) =>
    String(row?.props?.className ?? '').includes('justify-end'),
  );
}

const SUMMARY_ROOT = 'flex-1 min-w-0 flex flex-col bg-white overflow-hidden h-full w-full @container';
const TRANSCRIPT_ROOT = 'flex h-full min-w-0 w-full bg-white flex-col relative @container';

/** A summary that counts as visible content, so the text window is rendered. */
const visibleSummary = { markdown: '## Notes\n\nThe team agreed on the plan.' } as any;

// --- Slice 1: the summary text window carries the meeting date -------------

test('the summary text window shows the meeting date and time in its top-right corner', async () => {
  const view = await render(
    <SummaryPanel {...summaryProps({ meetingDate, aiSummary: visibleSummary })} />,
  );

  expect(viewText(view)).toContain(expectedDate);

  const corner = view.root.findAll(
    (node) => node.type === 'h3' && String(node.props.className).includes('text-gray-500'),
  );
  expect(corner).toHaveLength(1);
  expect(textOf(corner[0].props.children)).toBe(expectedDate);
  // Grey, tabular figures, and pinned right by its wrapper.
  expect(String(corner[0].props.className)).toContain('tabular-nums');
  expect(String(corner[0].props.className)).toContain('whitespace-nowrap');
  const wrapper = corner[0].parent!;
  expect(String(wrapper.props.className)).toContain('justify-between');

  // The title and the date share one row, with the title first: left title,
  // right date, aligned at the top so a wrapped title never lifts the date.
  const title = headings(view, 'h1')[0];
  expect(title.parent).toBe(wrapper);
  const rowChildren = (wrapper.children as any[]).filter((child) => typeof child !== 'string');
  expect(rowChildren).toHaveLength(2);
  expect(rowChildren[0].props.className).toContain('text-2xl');
  expect(String(wrapper.props.className)).toContain('items-start');
});

test('the corner date comes from the meeting moment, not the row creation time', async () => {
  // The row was created at 21:00 local, the meeting itself happened at 14:32.
  // Showing `created_at` would date a one-hour call by its end (ADR-0005).
  const view = await render(
    <SummaryPanel {...summaryProps({ meetingDate, aiSummary: visibleSummary })} />,
  );

  expect(viewText(view)).not.toContain('18/11/2026, 21:00');
});

// --- Slice 2: neither panel header shows the date any more -----------------

test('the summary panel header no longer draws a date row', async () => {
  const view = await render(<SummaryPanel {...summaryProps({ meetingDate })} />);

  expect(dateRows(view, SUMMARY_ROOT)).toHaveLength(0);
});

test('the transcript panel header no longer draws a date row', async () => {
  const view = await render(<TranscriptPanel {...transcriptProps()} />);

  expect(dateRows(view, TRANSCRIPT_ROOT)).toHaveLength(0);
  expect(viewText(view)).not.toContain(expectedDate);
});

// --- Slice 3: no text and no date mean nothing is drawn --------------------

test('an empty summary window shows no date at all', async () => {
  const view = await render(<SummaryPanel {...summaryProps({ meetingDate })} />);

  // The empty state takes the whole pane; the corner belongs to the text.
  expect(viewText(view)).not.toContain(expectedDate);
});

test('a meeting without a date draws no corner in the summary window', async () => {
  const unknown = await render(
    <SummaryPanel {...summaryProps({ meetingDate: null, aiSummary: visibleSummary })} />,
  );
  expect(viewText(unknown)).not.toContain(expectedDate);

  if (renderer) await act(async () => renderer!.unmount());
  const unusable = await render(
    <SummaryPanel {...summaryProps({ meetingDate: 'not-a-date', aiSummary: visibleSummary })} />,
  );
  // Neither a placeholder nor the current moment: the formatter returns null.
  expect(viewText(unusable)).not.toContain(expectedDate);
});

// --- Slice 4: switching tabs cannot duplicate the date ---------------------

test('the date appears exactly once across both tabs', async () => {
  // The split view mounts only the active tab, so each tab gets its own
  // render: the date lives in the summary text window and nowhere else.
  const { MeetingDetailsSplitView } = await import(
    '../../src/components/MeetingDetails/MeetingDetailsSplitView'
  );

  const splitView = (activeTab: 'transcript' | 'summary') => (
    <MeetingDetailsSplitView
      activeTab={activeTab}
      onTabChange={() => {}}
      transcript={<TranscriptPanel {...transcriptProps()} />}
      summary={
        <SummaryPanel {...summaryProps({ meetingDate, aiSummary: visibleSummary })} />
      }
    />
  );

  const transcriptTab = await render(splitView('transcript'));
  expect(
    transcriptTab.root.findAll(
      (node) => typeof node.type === 'string' && String(node.props.className).includes('tabular-nums'),
    ),
  ).toHaveLength(0);
  expect(dateRows(transcriptTab, TRANSCRIPT_ROOT)).toHaveLength(0);

  if (renderer) await act(async () => renderer!.unmount());
  const summaryTab = await render(splitView('summary'));

  const dates = summaryTab.root.findAll(
    (node) => typeof node.type === 'string' && String(node.props.className).includes('tabular-nums'),
  );
  expect(dates).toHaveLength(1);
  expect(textOf(dates[0].props.children)).toBe(expectedDate);
  expect(dateRows(summaryTab, SUMMARY_ROOT)).toHaveLength(0);
});

// --- Slice 5: the full meeting title heads the summary text window ---------

/** The heading elements rendered anywhere in a tree. */
function headings(instance: ReactTestRenderer, tag: string) {
  return instance.root.findAll(
    (node) => typeof node.type === 'string' && node.type === tag,
  );
}

test('the summary text window shows the full meeting title as its main heading', async () => {
  const view = await render(
    <SummaryPanel {...summaryProps({ meetingDate, aiSummary: visibleSummary })} />,
  );

  const titles = headings(view, 'h1');
  expect(titles).toHaveLength(1);
  expect(textOf(titles[0].props.children)).toBe('Planning call');

  // Same size and weight as the accepted meeting title heading
  // (EditableTitle), black, and wrapping instead of any clipping.
  const classes = String(titles[0].props.className);
  expect(classes).toContain('text-2xl');
  expect(classes).toContain('font-bold');
  expect(classes).toContain('text-black');
  expect(classes).not.toContain('line-clamp');
  expect(classes).not.toContain('truncate');
});

test('a long title is rendered in full, wrapping instead of clipping', async () => {
  const longTitle = 'Кросс-функциональный разбор инцидента в платёжном шлюзе '
    + 'с участием команд платформы, поддержки и аналитики данных, 18 ноября 2026';
  const view = await render(
    <SummaryPanel
      {...summaryProps({ meetingDate, meetingTitle: longTitle, aiSummary: visibleSummary })}
    />,
  );

  const titles = headings(view, 'h1');
  expect(titles).toHaveLength(1);
  // The whole title reaches the text window: no truncation, and it may break
  // across lines (`break-words`), so nothing is lost.
  expect(textOf(titles[0].props.children)).toBe(longTitle);
  expect(viewText(view)).toContain(longTitle);
  expect(String(titles[0].props.className)).toContain('break-words');
});

test('the title shows and the date stays away when the meeting date is unknown', async () => {
  const unknown = await render(
    <SummaryPanel {...summaryProps({ meetingDate: null, aiSummary: visibleSummary })} />,
  );

  const unknownTitles = headings(unknown, 'h1');
  expect(unknownTitles).toHaveLength(1);
  expect(textOf(unknownTitles[0].props.children)).toBe('Planning call');
  // No date, no placeholder, and never the current moment (ADR-0005).
  expect(viewText(unknown)).not.toContain(expectedDate);
  const unknownCorners = unknown.root.findAll(
    (node) => typeof node.type === 'string' && String(node.props.className).includes('tabular-nums'),
  );
  expect(unknownCorners).toHaveLength(0);

  if (renderer) await act(async () => renderer!.unmount());
  const unusable = await render(
    <SummaryPanel {...summaryProps({ meetingDate: 'not-a-date', aiSummary: visibleSummary })} />,
  );
  const unusableTitles = headings(unusable, 'h1');
  expect(unusableTitles).toHaveLength(1);
  expect(textOf(unusableTitles[0].props.children)).toBe('Planning call');
  expect(viewText(unusable)).not.toContain(expectedDate);
  const unusableCorners = unusable.root.findAll(
    (node) => typeof node.type === 'string' && String(node.props.className).includes('tabular-nums'),
  );
  expect(unusableCorners).toHaveLength(0);
});

test('the title never appears in the transcript panel and never duplicates in split view', async () => {
  const transcriptOnly = await render(<TranscriptPanel {...transcriptProps()} />);
  expect(headings(transcriptOnly, 'h1')).toHaveLength(0);
  expect(viewText(transcriptOnly)).not.toContain('Planning call');
  if (renderer) await act(async () => renderer!.unmount());

  // The split view mounts only the active tab: the title is read once, next
  // to the summary, and the transcript tab shows no title at all.
  const { MeetingDetailsSplitView } = await import(
    '../../src/components/MeetingDetails/MeetingDetailsSplitView'
  );

  const splitView = (activeTab: 'transcript' | 'summary') => (
    <MeetingDetailsSplitView
      activeTab={activeTab}
      onTabChange={() => {}}
      transcript={<TranscriptPanel {...transcriptProps()} />}
      summary={
        <SummaryPanel {...summaryProps({ meetingDate, aiSummary: visibleSummary })} />
      }
    />
  );

  const transcriptTab = await render(splitView('transcript'));
  expect(headings(transcriptTab, 'h1')).toHaveLength(0);

  if (renderer) await act(async () => renderer!.unmount());
  const summaryTab = await render(splitView('summary'));

  const titles = headings(summaryTab, 'h1');
  expect(titles).toHaveLength(1);
  expect(textOf(titles[0].props.children)).toBe('Planning call');
  // The date remains the only element with tabular figures in the row.
  const corners = summaryTab.root.findAll(
    (node) => typeof node.type === 'string' && String(node.props.className).includes('tabular-nums'),
  );
  expect(corners).toHaveLength(1);
});
