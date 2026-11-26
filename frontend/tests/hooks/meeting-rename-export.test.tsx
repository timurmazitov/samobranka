import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { SummaryProcessResponse } from '../../src/types';

// Seam #1 of the meeting-title spec: the full meeting route together with the
// real SidebarProvider, the real notes column with its meeting row and edit
// dialog, and the real summary/transcript panels and export hooks, all under
// the mocked Tauri boundary. The user scenario runs end to end — open the
// meeting, rename it through the row's edit dialog, press Export — and only
// the externally visible results are asserted: the `defaultFileName` the save
// dialog was asked for and the document body. Prior art:
// meeting-details-refresh.test.tsx (route seam), notes-column.test.tsx (real
// notes column under mocks), copy-export-operations.test.tsx (export
// assertions).

// Bun shares module mocks between test files; capture the originals first and
// restore every mocked application module in `afterAll`.
const originalCore = { ...await import('@tauri-apps/api/core') };
const originalEvent = { ...await import('@tauri-apps/api/event') };
const originalNavigation = { ...await import('next/navigation') };
const originalToast = { ...await import('sonner') };
const originalPreferences = { ...await import('../../src/lib/summary-language-preferences') };
const originalConfig = { ...await import('../../src/contexts/ConfigContext') };
const originalRecordingState = { ...await import('../../src/contexts/RecordingStateContext') };
const originalImportDialog = { ...await import('../../src/contexts/ImportDialogContext') };
const originalOllamaDownload = { ...await import('../../src/contexts/OllamaDownloadContext') };
const originalLanguageContext = { ...await import('../../src/contexts/LanguageContext') };
// Radix Presence picks React.useLayoutEffect only when `document` exists at
// module load; without it the hook is a no-op and the meeting view's inactive
// tab never unmounts here (in the app a document always exists). Declared
// before the Radix-backed imports below so those modules load with the real
// hook; the true original is restored in `afterAll`.
const documentBeforeShim = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    // Module-scope feature detection (prosemirror) reads this at import time.
    documentElement: { style: {} },
  }),
});
const originalDialog = { ...await import('../../src/components/ui/dialog') };
const originalPopover = { ...await import('../../src/components/ui/popover') };
const originalTooltip = { ...await import('../../src/components/ui/tooltip') };
const originalDropdownMenu = { ...await import('../../src/components/ui/dropdown-menu') };
const originalBlockNote = { ...await import('../../src/components/AISummary/BlockNoteSummaryView') };
const originalLogo = { ...await import('../../src/components/Logo') };
const originalModelSettingsModal = { ...await import('../../src/components/ModelSettingsModal') };
const originalFramer = { ...await import('framer-motion') };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('@tauri-apps/api/event', () => originalEvent);
  mock.module('next/navigation', () => originalNavigation);
  mock.module('sonner', () => originalToast);
  mock.module('../../src/lib/summary-language-preferences', () => originalPreferences);
  mock.module('../../src/contexts/ConfigContext', () => originalConfig);
  mock.module('../../src/contexts/RecordingStateContext', () => originalRecordingState);
  mock.module('../../src/contexts/ImportDialogContext', () => originalImportDialog);
  mock.module('../../src/contexts/OllamaDownloadContext', () => originalOllamaDownload);
  mock.module('../../src/contexts/LanguageContext', () => originalLanguageContext);
  mock.module('../../src/components/ui/dialog', () => originalDialog);
  mock.module('../../src/components/ui/popover', () => originalPopover);
  mock.module('../../src/components/ui/tooltip', () => originalTooltip);
  mock.module('../../src/components/ui/dropdown-menu', () => originalDropdownMenu);
  mock.module('../../src/components/AISummary/BlockNoteSummaryView', () => originalBlockNote);
  mock.module('../../src/components/Logo', () => originalLogo);
  mock.module('../../src/components/ModelSettingsModal', () => originalModelSettingsModal);
  // framer-motion stays mocked for the process, as the other component suites do.
  if (documentBeforeShim) Object.defineProperty(globalThis, 'document', documentBeforeShim);
  else Reflect.deleteProperty(globalThis, 'document');
});

const React = { ...await import('react') };
const Container = ({ children }: any) => children ?? null;

// Radix portals (dialogs, popovers, tooltips, dropdowns) need a real DOM; the
// assertions here are text and invoke arguments, so the wrappers become plain
// containers and their children always render.
mock.module('../../src/components/ui/dialog', () => ({
  Dialog: Container,
  DialogContent: Container,
  DialogDescription: Container,
  DialogFooter: Container,
  DialogHeader: Container,
  DialogPortal: Container,
  DialogTitle: Container,
  DialogTrigger: Container,
}));
mock.module('../../src/components/ui/popover', () => ({
  Popover: Container,
  PopoverAnchor: Container,
  PopoverContent: Container,
  PopoverTrigger: Container,
}));
mock.module('../../src/components/ui/tooltip', () => ({
  Tooltip: Container,
  TooltipContent: Container,
  TooltipProvider: Container,
  TooltipTrigger: Container,
}));
mock.module('../../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: Container,
  DropdownMenuCheckboxItem: Container,
  DropdownMenuContent: Container,
  DropdownMenuGroup: Container,
  DropdownMenuItem: Container,
  DropdownMenuLabel: Container,
  DropdownMenuRadioGroup: Container,
  DropdownMenuRadioItem: Container,
  DropdownMenuSeparator: () => null,
  DropdownMenuTrigger: Container,
}));
// BlockNote needs a real DOM. The export reads the editor through the ref the
// panels own, and that ref stays null here, so the export falls back to the
// saved markdown — exactly the path this suite exercises.
mock.module('../../src/components/AISummary/BlockNoteSummaryView', () => ({
  BlockNoteSummaryView: React.forwardRef(() => <div data-summary-body="true" />),
}));
mock.module('../../src/components/Logo', () => ({ default: () => null }));
// The model-settings dialog chrome (cmdk needs a real DOM and the modal reads
// unrelated backend settings on mount); nothing under test lives inside it.
mock.module('../../src/components/ModelSettingsModal', () => ({ ModelSettingsModal: () => null }));
// framer-motion cannot detect SVG elements without a DOM (same trick as the
// panel suites; it stays installed for the process).
const motionContainer = (props: any) => <div>{props.children}</div>;
mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => motionContainer }),
  AnimatePresence: Container,
}));
// The route and the sidebar read the recording state and the auto-summary
// toggle; the copy hook reads the interface language through `useAppLanguage`,
// which it only uses for date formatting, so a fixed English context is the
// intended contract here.
mock.module('../../src/contexts/RecordingStateContext', () => ({
  useRecordingState: () => ({ isRecording: false }),
}));
mock.module('../../src/contexts/ConfigContext', () => ({
  useConfig: () => ({
    isAutoSummary: false,
    modelConfig: { provider: 'ollama', model: 'test', whisperModel: 'base' },
    setModelConfig: () => {},
    isModelConfigLoading: false,
    selectedLanguage: 'auto',
    transcriptModelConfig: { provider: 'whisper', model: 'large-v3' },
  }),
}));
mock.module('../../src/contexts/ImportDialogContext', () => ({
  useImportDialog: () => ({ openImportDialog: () => {} }),
}));
mock.module('../../src/contexts/OllamaDownloadContext', () => ({
  useOllamaDownload: () => ({
    isDownloading: () => false,
    getProgress: () => undefined,
    downloadingModels: new Set<string>(),
  }),
}));
mock.module('../../src/contexts/LanguageContext', () => ({
  useAppLanguage: () => ({ language: 'en', ready: true, setLanguage: async () => {} }),
}));
mock.module('../../src/lib/summary-language-preferences', () => ({
  readCachedDetectedSummaryLanguage: async () => null,
  detectAndCacheSummaryLanguage: async () => ({ language: 'en' }),
  readMeetingSummaryLanguage: async () => ({ language: 'en', storage: 'metadata' }),
  saveMeetingSummaryLanguage: async () => ({ language: 'en', storage: 'metadata' }),
}));
const notify = mock(() => {});
mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));
// The sidebar and the native-event bridges subscribe on mount; the
// subscriptions themselves are irrelevant here.
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}));

/** The single meeting the route and the sidebar show. */
const MEETING_ID = 'meeting-a';
const RECORDED_AT = '2026-10-02T09:15:00';
const SUMMARY_MARKDOWN = '## Decisions\n\n- Ship on Friday';

let selectedMeeting = MEETING_ID;
mock.module('next/navigation', () => ({
  usePathname: () => '/meeting-details',
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams({ id: selectedMeeting }),
}));

/** The meeting title as the backend currently stores it. */
let storedTitle = 'Release planning';
/** Rows `api_get_meetings` answers with; date and length must survive a rename. */
let listRows: Array<{ id: string; title: string; recorded_at?: string | null; duration_seconds?: number | null }> = [];
let summaryResponse: SummaryProcessResponse;

const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'api_get_meetings') return listRows;
  if (command === 'doodle_sync') return null;
  if (command === 'api_get_model_config') return null;
  if (command === 'api_get_transcript_config') return null;
  if (command === 'api_list_templates') return [];
  if (command === 'api_get_summary') return { ...summaryResponse, meeting_id: args!.meetingId };
  if (command === 'api_get_meeting_metadata') {
    return {
      id: args!.meetingId,
      title: storedTitle,
      created_at: '2026-09-01',
      updated_at: '2026-09-01',
      folder_path: '/meetings/meeting-a',
      recorded_at: RECORDED_AT,
    };
  }
  if (command === 'api_get_meeting_transcripts') {
    return {
      transcripts: [{ id: 'transcript-1', text: 'We shipped it', timestamp: '00:00' }],
      total_count: 1,
      has_more: false,
    };
  }
  if (command === 'api_get_meeting_speakers') return [{ label: 'SPEAKER_00', speaker_name: null }];
  if (command === 'get_ollama_models') return [{ name: 'gemma3:1b' }];
  if (command === 'api_process_transcript') return { process_id: 'attempt-a' };
  if (command === 'api_save_meeting_title') {
    // The backend's own contract (`api_save_meeting_title`): an untouched date
    // arrives as `null` and is left alone; a new title becomes stored truth.
    storedTitle = String(args!.title);
    listRows = listRows.map(row => ({
      ...row,
      title: storedTitle,
      ...(args!.recordedAt ? { recorded_at: String(args!.recordedAt) } : {}),
    }));
    return null;
  }
  if (command === 'export_transcript_file_command') return '/home/user/exports/exported-file';
  throw new Error(`Unexpected command: ${command} (${JSON.stringify(args)})`);
});
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));

const { SidebarProvider } = await import('../../src/components/Sidebar/SidebarProvider');
const { default: NotesColumn } = await import('../../src/components/NotesColumn');
const { default: MeetingDetails } = await import('../../src/app/meeting-details/page');

let renderer: ReactTestRenderer | undefined;
const timers = new Map<number, () => Promise<void>>();
let nextTimer = 0;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const clipboardWrites: string[] = [];
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');

beforeEach(() => {
  // The route and the sidebar run in the browser; bun's test environment has
  // no DOM, so `window` is the global itself (EventTarget included — the
  // metadata-updated event travels over it) and `document` is the EventTarget
  // stub the prior route test uses.
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { clipboardWrites.push(text); } },
  });
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
  (globalThis as any).matchMedia = (query: string) => ({
    matches: true,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  // Radix (tabs) schedules a mount animation on the bare global.
  (globalThis as any).requestAnimationFrame = (callback: () => void) => { callback(); return 0; };
  (globalThis as any).cancelAnimationFrame = () => {};
  setSystemTime(new Date(2026, 10, 18, 10, 30));
  selectedMeeting = MEETING_ID;
  storedTitle = 'Release planning';
  listRows = [{ id: MEETING_ID, title: storedTitle, recorded_at: RECORDED_AT, duration_seconds: 4975.5 }];
  summaryResponse = {
    meeting_id: MEETING_ID,
    status: 'completed',
    start: 'attempt-a',
    end: null,
    data: { markdown: SUMMARY_MARKDOWN },
    error: null,
    meetingName: null,
  };
  clipboardWrites.length = 0;
  invoke.mockClear();
  notify.mockClear();
  timers.clear();
  globalThis.setInterval = ((callback: () => Promise<void>) => {
    const id = ++nextTimer;
    timers.set(id, callback);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as typeof clearInterval;
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  setSystemTime();
  if (originalClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'localStorage');
  Reflect.deleteProperty(globalThis, 'matchMedia');
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

/** React synthetic-event stand-in: the handlers only call `stopPropagation`. */
const fakeEvent = { stopPropagation: () => {}, preventDefault: () => {} };

async function show() {
  await act(async () => {
    renderer = create(
      <SidebarProvider>
        <NotesColumn />
        <MeetingDetails />
      </SidebarProvider>,
    );
  });
  // The provider fetches the meeting rows; the route loads metadata,
  // transcripts, the speaker list and the stored summary. The notes column is
  // permanent, so the rows are rendered without any expanding step.
  await act(async () => {});
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node?.children) return node.children.map(textOf).join('');
  return '';
}

function viewText(): string {
  return textOf(renderer!.toJSON());
}

/** Buttons whose accessible title is exactly `title` (Copy/Export/Generate). */
function buttonByTitle(title: string) {
  const found = renderer!.root.findAll(
    (node: any) => node.type === 'button' && node.props.title === title,
  );
  expect(found.length).toBeGreaterThanOrEqual(1);
  return found[0];
}

/** The edit dialog's Save button: plain text `Save`, sidebar renders first. */
function dialogSaveButton() {
  const found = renderer!.root.findAll(
    (node: any) => node.type === 'button' && node.props.disabled !== true
      && textOf(node).trim() === 'Save',
  );
  expect(found.length).toBeGreaterThanOrEqual(1);
  return found[0];
}

/** Open the row's edit dialog and save a new title, leaving the date alone. */
async function renameThroughSidebar(newTitle: string) {
  const editButton = renderer!.root.find(
    (node: any) => node.type === 'button' && node.props['aria-label'] === 'Edit meeting details',
  );
  await act(async () => { editButton.props.onClick(fakeEvent); });
  const titleInput = renderer!.root.find(
    (node: any) => node.type === 'input' && node.props.id === 'meeting-title',
  );
  await act(async () => { titleInput.props.onChange({ target: { value: newTitle } }); });
  await act(async () => { dialogSaveButton().props.onClick(fakeEvent); });
  await act(async () => {});
}

function callsOf(command: string) {
  return invoke.mock.calls.filter(([name]) => name === command);
}

async function clickSummary(action: 'Export Summary' | 'Copy Summary') {
  await act(async () => { buttonByTitle(action).props.onClick(fakeEvent); });
  await act(async () => {});
}

async function clickExportTranscript() {
  await act(async () => { buttonByTitle('Export Transcript').props.onClick(fakeEvent); });
  await act(async () => {});
}

/** Switch the meeting view's tab the way a user clicks the tab strip. */
async function switchTab(label: 'Transcript' | 'Summary') {
  const tab = renderer!.root.findAll(
    (node: any) => node.type === 'button' && node.props.role === 'tab'
      && textOf(node).includes(label),
  )[0];
  expect(tab).toBeDefined();
  await act(async () => {
    tab.props.onMouseDown({ button: 0, ctrlKey: false, ...fakeEvent });
  });
  await act(async () => {});
}

function exportCalls() {
  return callsOf('export_transcript_file_command');
}

async function tick() {
  await act(async () => {
    for (const callback of [...timers.values()]) await callback();
  });
}

describe('rename then export through the sidebar (seam #1)', () => {
  test('the summary export after a sidebar rename names the file and the document with the new title', async () => {
    await show();
    await renameThroughSidebar('Renamed planning call');

    // The open page shows the new title right away, without a reload: the
    // summary window heads its text with it.
    const titles = renderer!.root.findAll((node: any) => node.type === 'h1');
    expect(titles).toHaveLength(1);
    expect(textOf(titles[0].props.children)).toBe('Renamed planning call');

    await clickSummary('Export Summary');

    expect(exportCalls()).toHaveLength(1);
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    // `<YYYYMMDD>-<title>-<kind>.<ext>` with the existing sanitisation: spaces
    // become underscores; the date is the meeting's own day (ADR-0005).
    expect(args.defaultFileName).toBe('20261002-Renamed_planning_call-summary.md');
    expect(args.content).toStartWith(`# Meeting Summary: Renamed planning call\n\n`);
    expect(args.content).not.toContain('# Meeting Summary: Release planning');
  });

  test('the transcript export after a sidebar rename names the file and the document with the new title', async () => {
    await show();
    await renameThroughSidebar('Renamed planning call');

    // Only one panel is mounted at a time; the transcript lives on its tab.
    await switchTab('Transcript');
    await clickExportTranscript();

    expect(exportCalls()).toHaveLength(1);
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261002-Renamed_planning_call-transcript.txt');
    expect(args.content).toContain('# Transcript of the Meeting: meeting-a - Renamed planning call');
    expect(args.content).not.toContain('Release planning');
  });

  test('copying the summary after a rename puts the same new title on the clipboard as the export writes', async () => {
    await show();
    await renameThroughSidebar('Renamed planning call');

    await clickSummary('Copy Summary');

    expect(clipboardWrites[0]).toStartWith('# Meeting Summary: Renamed planning call\n\n');
    expect(clipboardWrites[0]).toContain('**Copied on:**');
    // The copy is the same document the Export button saves, apart from the
    // label word.
    await clickSummary('Export Summary');
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.content).toBe(clipboardWrites[0].replace('**Copied on:**', '**Exported on:**'));
  });

  test('a title-only rename reloads metadata without reloading the transcripts page or the speakers', async () => {
    await show();
    const transcriptsBefore = callsOf('api_get_meeting_transcripts').length;
    const speakersBefore = callsOf('api_get_meeting_speakers').length;

    await renameThroughSidebar('Renamed planning call');

    // The rename reached the backend, and the open page reloaded its
    // metadata… (`api_get_meeting_metadata` at least once more than at boot)
    expect(callsOf('api_save_meeting_title')).toHaveLength(1);
    expect(callsOf('api_get_meeting_metadata').length).toBeGreaterThanOrEqual(2);
    // …while the transcript page and the speaker list stayed exactly as they
    // were: a title cannot change their content.
    expect(callsOf('api_get_meeting_transcripts')).toHaveLength(transcriptsBefore);
    expect(callsOf('api_get_meeting_speakers')).toHaveLength(speakersBefore);
  });

  test('a rename sends no date to the backend and keeps the row date and length', async () => {
    await show();

    await renameThroughSidebar('Renamed planning call');

    const saveCall = callsOf('api_save_meeting_title')[0];
    expect(saveCall?.[1]?.title).toBe('Renamed planning call');
    // Untouched date field: `null` means "do not touch the stored moment".
    expect(saveCall?.[1]?.recordedAt).toBeNull();
    // The row still shows the meeting date and the meeting length under the title.
    expect(viewText()).toContain('2/10/2026, 09:15');
    expect(viewText()).toContain('1 h 23 min');
  });

  test('the auto-title from summary generation reaches the export and the sidebar row', async () => {
    // A meeting without a summary yet: the user generates one and the model
    // names the meeting (`MeetingName` in the summary payload).
    summaryResponse = { ...summaryResponse, status: 'idle', data: null, start: null };
    await show();

    // Without a summary the view stays on the transcript tab; the generate
    // button lives on the summary tab.
    await switchTab('Summary');
    await act(async () => { buttonByTitle('Generate AI Summary').props.onClick(fakeEvent); });
    await act(async () => {});
    // The backend finished the run; as `service.rs` does, a generated name is
    // also written to the meetings row, so the list converges on it.
    summaryResponse = {
      ...summaryResponse,
      status: 'completed',
      start: 'attempt-a',
      data: { markdown: SUMMARY_MARKDOWN, MeetingName: 'Q3 Budget Review' },
    };
    storedTitle = 'Q3 Budget Review';
    listRows = listRows.map(row => ({ ...row, title: storedTitle }));
    for (let i = 0; i < 3; i += 1) await tick();

    await clickSummary('Export Summary');

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261002-Q3_Budget_Review-summary.md');
    expect(args.content).toStartWith('# Meeting Summary: Q3 Budget Review\n\n');
    // The sidebar row follows the auto-title too.
    expect(viewText()).toContain('Q3 Budget Review');
  });
});
