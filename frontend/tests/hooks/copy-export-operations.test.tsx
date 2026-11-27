import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { RefObject } from 'react';
import type { BlockNoteSummaryViewRef } from '../../src/components/AISummary/BlockNoteSummaryView';
import type { MeetingSummary, Transcript } from '../../src/types';

// Bun shares module mocks between test files; restore application modules after this suite.
const originalCore = { ...await import('@tauri-apps/api/core') };
const originalToast = { ...await import('sonner') };
// `window` is absent in the default bun test environment; remember that so later
// suites that rely on its absence (react-dom/server) are not affected by our shim.
const globalWindow = globalThis as any;
const hadWindow = 'window' in globalWindow;
const originalWindow = globalWindow.window;
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
  mock.module('sonner', () => originalToast);
  mock.module('../../src/contexts/LanguageContext', () => originalLanguageContext);
  if (hadWindow) globalWindow.window = originalWindow;
  else Reflect.deleteProperty(globalWindow, 'window');
});

const successToast = mock(() => {});
const errorToast = mock(() => {});
const warningToast = mock(() => {});

// `useCopyOperations` reads the interface language through `useAppLanguage`,
// which throws outside a `LanguageProvider`. The hook uses the language only
// for date formatting in the documents, so a fixed English context is the
// intended contract here; rendering under the real provider would drag the
// Tauri preference store into this suite for no additional coverage.
const originalLanguageContext = { ...await import('../../src/contexts/LanguageContext') };
mock.module('../../src/contexts/LanguageContext', () => ({
  useAppLanguage: () => ({ language: 'en', ready: true, setLanguage: async () => {} }),
}));

const transcript: Transcript = { id: 'transcript-1', text: 'We shipped it', timestamp: '00:00' };
let transcriptsPage: { transcripts: Transcript[]; total_count: number; has_more: boolean };
let savedPath: string | null;
let saveError: Error | null;
const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'api_get_meeting_transcripts') return transcriptsPage;
  if (command === 'export_transcript_file_command') {
    if (saveError) throw saveError;
    return savedPath;
  }
  throw new Error(`Unexpected command: ${command} (${JSON.stringify(args)})`);
});

/**
 * Re-apply the test doubles for one test.
 *
 * Bun shares module mocks between test files, and another suite's `afterAll`
 * restore can run after this file was loaded, so a mock registered only at
 * module load may be gone by the first test. The `window` shim additionally
 * covers the case where `export-file.ts` is already bound to the real `invoke`:
 * the real `invoke` delegates to `window.__TAURI_INTERNALS__.invoke`.
 */
function installTestDoubles() {
  mock.module('sonner', () => ({
    toast: { success: successToast, error: errorToast, info: mock(() => {}), warning: warningToast },
  }));
  mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
  (globalThis as any).window ??= {};
  (globalThis as any).window.__TAURI_INTERNALS__ = { invoke };
}
installTestDoubles();

const { useCopyOperations } = await import('../../src/hooks/meeting-details/useCopyOperations');

const meeting = { id: 'meeting-1', title: 'Release planning', created_at: '2026-11-18' };

/**
 * The meeting's own moment (GLOSSARY: «дата встречи»), which the page reads from
 * the meeting metadata. Absent while unknown, so the tests that do not set it
 * exercise a legacy meeting that has no date at all.
 */
let meetingRecordedAt: string | null | undefined;

/**
 * The row's creation time (GLOSSARY ADR-0005: an audit field, not the meeting
 * date). Overridable so a test can prove it is never consulted as a date source.
 */
let meetingCreatedAt: string;

const clipboardWrites: string[] = [];
const writeText = mock(async (text: string) => {
  clipboardWrites.push(text);
});
const originalClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');

let operations: ReturnType<typeof useCopyOperations>;
function Harness(props: Parameters<typeof useCopyOperations>[0]) {
  operations = useCopyOperations(props);
  return null;
}

let renderer: ReactTestRenderer | undefined;
let editorMarkdown: string | null;
let aiSummary: MeetingSummary | null;
let titleFromProps: string;

async function show() {
  const ref = {
    current: {
      getMarkdown: async () => editorMarkdown ?? '',
      saveSummary: async () => {},
      isDirty: false,
    },
  } as RefObject<BlockNoteSummaryViewRef>;

  await act(async () => {
    renderer = create(
      <Harness
        meeting={{ ...meeting, created_at: meetingCreatedAt, recorded_at: meetingRecordedAt }}
        transcripts={[]}
        meetingTitle={titleFromProps}
        aiSummary={aiSummary}
        blockNoteSummaryRef={ref}
      />,
    );
  });
}

beforeEach(() => {
  installTestDoubles();
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  setSystemTime(new Date(2026, 10, 18, 10, 30));
  transcriptsPage = { transcripts: [transcript], total_count: 1, has_more: false };
  savedPath = '/home/user/exports/20261118-Release_planning-summary.md';
  saveError = null;
  titleFromProps = meeting.title;
  meetingRecordedAt = undefined;
  meetingCreatedAt = meeting.created_at;
  editorMarkdown = '## Decisions\n\n- Ship on Friday';
  aiSummary = { markdown: '## Saved summary' } as MeetingSummary;
  clipboardWrites.length = 0;
  invoke.mockClear();
  writeText.mockClear();
  successToast.mockClear();
  errorToast.mockClear();
  warningToast.mockClear();
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  setSystemTime();
  if (originalClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(globalThis.navigator, 'clipboard');
});

function exportCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'export_transcript_file_command');
}

/** One `**<label>:** …` line of a document's metadata block. */
function metadataLine(document: string, label: string): string | undefined {
  return document
    .split('\n')
    .find(line => line.startsWith(`**${label}:**`));
}

describe('the document date is the meeting date, not the row creation time', () => {
  test('copies the summary with the meeting date the screen shows', async () => {
    // The row was created on 18 November (when the recording was saved or the
    // file imported); the meeting itself happened on 2 October. The copied
    // document must name the meeting's own day.
    meetingRecordedAt = '2026-10-02T09:15:00';

    await show();
    await act(async () => {
      await operations.handleCopySummary();
    });

    expect(metadataLine(clipboardWrites[0], 'Date')).toBe('**Date:** October 2, 2026 at 09:15 AM');
    // The moment of copying still belongs to the copy, not the meeting.
    expect(metadataLine(clipboardWrites[0], 'Copied on'))
      .toBe('**Copied on:** November 18, 2026 at 10:30 AM');
  });

  test('exports the summary with the same day in the file name and the document', async () => {
    meetingRecordedAt = '2026-10-02T09:15:00';

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261002-Release_planning-summary.md');
    expect(args.content).toContain('**Date:** October 2, 2026 at 09:15 AM');
  });

  test('copies the transcript with the meeting date in its header', async () => {
    meetingRecordedAt = '2026-10-02T09:15:00';

    await show();
    await act(async () => {
      await operations.handleCopyTranscript();
    });

    const expectedDay = new Date(2026, 9, 2).toLocaleDateString();
    expect(clipboardWrites[0]).toContain(`## Date: ${expectedDay}`);
  });

  test('exports the transcript under a file name built from the meeting date', async () => {
    meetingRecordedAt = '2026-10-02T09:15:00';
    savedPath = '/home/user/exports/20261002-Release_planning-transcript.md';

    await show();
    await act(async () => {
      await operations.handleExportTranscript();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261002-Release_planning-transcript.md');
  });

  test('keeps the current-moment fallback for a meeting without a meeting date', async () => {
    // The row's creation time is deliberately not used as a fallback: it names
    // when the row appeared in the database — for a recording that is after the
    // meeting ended. With no meeting date at all, Copy and Export fall back to
    // the current moment, which is the long-standing export behaviour.
    meetingRecordedAt = undefined;

    await show();
    await act(async () => {
      await operations.handleCopySummary();
    });
    await act(async () => {
      await operations.handleExportSummary();
    });
    await act(async () => {
      await operations.handleCopyTranscript();
    });

    // `setSystemTime` froze the clock on 18 November 2026, 10:30, which is the
    // fallback moment — an hour that `created_at` (bare `YYYY-MM-DD`) could
    // never produce, so the two are distinguishable here.
    expect(clipboardWrites[0]).toContain('**Date:** November 18, 2026 at 10:30 AM');
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261118-Release_planning-summary.md');
    expect(args.content).toContain('**Date:** November 18, 2026 at 10:30 AM');
    expect(clipboardWrites[2]).toContain(`## Date: ${new Date(2026, 10, 18).toLocaleDateString()}`);
  });

  test('never reads the row creation time as a date source', async () => {
    // Even when a row has no meeting date, `created_at` must not date the
    // document: it names when the row reached the database, which for a
    // recording is after the meeting ended.
    meetingRecordedAt = undefined;
    meetingCreatedAt = '2026-03-04T18:00:00';

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261118-Release_planning-summary.md');
    expect(args.content).toContain('**Date:** November 18, 2026 at 10:30 AM');
  });

  test('treats an empty meeting date like an absent one', async () => {
    meetingRecordedAt = '';

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261118-Release_planning-summary.md');
    expect(args.content).toContain('**Date:** November 18, 2026 at 10:30 AM');
  });
});

describe('summary export through the native dialog', () => {
  test('asks for a markdown file and writes the document with the Exported label', async () => {
    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(exportCalls()).toHaveLength(1);
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.extension).toBe('md');
    expect(args.filterLabel).toBe('Markdown Files');
    expect(args.defaultFileName).toBe('20261118-Release_planning-summary.md');

    const content = args.content as string;
    expect(content).toStartWith('# Meeting Summary: Release planning\n\n');
    expect(content).toContain('**Meeting ID:** meeting-1');
    expect(content).toContain('**Date:** November 18, 2026');
    expect(content).toContain('**Exported on:**');
    expect(content).not.toContain('**Copied on:**');
    expect(content).toEndWith('---\n\n## Decisions\n\n- Ship on Friday');
  });

  test('the file text equals the copied text except for the label word', async () => {
    await show();
    await act(async () => {
      await operations.handleCopySummary();
    });
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(clipboardWrites).toHaveLength(2); // the copied document, then the saved path
    const copied = clipboardWrites[0];
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(copied).toContain('**Copied on:**');
    expect(args.content).toBe(copied.replace('**Copied on:**', '**Exported on:**'));
  });

  test('exports the current editor state, including unsaved edits', async () => {
    editorMarkdown = '## Unsaveable edits';
    aiSummary = { markdown: '## Stale saved text' } as MeetingSummary;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.content).toContain('## Unsaveable edits');
    expect(args.content).not.toContain('## Stale saved text');
    // Export must not auto-save the summary: only the transcript read and the dialog ran.
    expect(invoke.mock.calls.map(([command]) => command))
      .toEqual(['export_transcript_file_command']);
  });

  test('falls back to the saved markdown when the editor is unavailable', async () => {
    editorMarkdown = null; // getMarkdown() resolves to an empty string
    aiSummary = { markdown: '## Saved summary' } as MeetingSummary;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.content).toContain('## Saved summary');
  });

  test('exports a legacy summary through the same resolution as Copy', async () => {
    editorMarkdown = null;
    aiSummary = {
      KeyPoints: { title: 'Key Points', blocks: [{ content: 'Ship it' }, { content: 'Tell users' }] },
    } as unknown as MeetingSummary;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.content).toEndWith('---\n\n## Key Points\n\n- Ship it\n- Tell users');
  });

  test('puts the saved path on the clipboard and reports success with it', async () => {
    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(clipboardWrites).toEqual(['/home/user/exports/20261118-Release_planning-summary.md']);
    expect(successToast).toHaveBeenCalledWith('Summary exported', {
      description: '/home/user/exports/20261118-Release_planning-summary.md',
    });
    expect(errorToast).not.toHaveBeenCalled();
  });

  test('cancelling the dialog leaves the clipboard and the toasts alone', async () => {
    savedPath = null;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(clipboardWrites).toEqual([]);
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalled();
  });

  test('a failing write reports an error and leaves the clipboard alone', async () => {
    saveError = new Error('permission denied');

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(clipboardWrites).toEqual([]);
    expect(successToast).not.toHaveBeenCalled();
    expect(errorToast).toHaveBeenCalledWith('Failed to export summary');
  });

  test('a clipboard failure after saving still reports the saved file', async () => {
    writeText.mockImplementationOnce(async () => {
      throw new Error('clipboard unavailable');
    });

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    // The file exists, so the export must not be reported as failed.
    expect(successToast).toHaveBeenCalledWith('Summary exported', {
      description: '/home/user/exports/20261118-Release_planning-summary.md',
    });
    expect(errorToast).not.toHaveBeenCalledWith('Failed to export summary');
    expect(warningToast).toHaveBeenCalledWith('Saved, but could not copy the path', {
      description: '/home/user/exports/20261118-Release_planning-summary.md',
    });
  });

  test('refuses to export when the summary has no visible content', async () => {
    editorMarkdown = null;
    aiSummary = { markdown: '   ' } as MeetingSummary;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    expect(exportCalls()).toHaveLength(0);
    expect(errorToast).toHaveBeenCalledWith('No summary content available to export');
    expect(clipboardWrites).toEqual([]);
  });

  test('falls back to the meeting title when the title prop is absent', async () => {
    // Both exports name the meeting the same way; the summary must not lose its
    // title just because the editable title prop is missing.
    titleFromProps = undefined as unknown as string;

    await show();
    await act(async () => {
      await operations.handleExportSummary();
    });

    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.defaultFileName).toBe('20261118-Release_planning-summary.md');
    expect(args.content).toContain('# Meeting Summary: Release planning');
  });
});

describe('transcript export keeps its markdown file contract', () => {
  test('copies the meeting date as its local calendar day', async () => {
    // The meeting date may arrive as a bare `YYYY-MM-DD`; reading it as UTC
    // midnight would print the previous day west of Greenwich.
    meetingRecordedAt = '2026-11-18';

    await show();
    await act(async () => {
      await operations.handleCopyTranscript();
    });

    const expectedDay = new Date(2026, 10, 18).toLocaleDateString();
    expect(clipboardWrites[0]).toContain(`## Date: ${expectedDay}`);
  });

  test('sends md and Markdown Files to the shared command', async () => {
    savedPath = '/home/user/exports/20261118-Release_planning-transcript.md';

    await show();
    await act(async () => {
      await operations.handleExportTranscript();
    });

    expect(exportCalls()).toHaveLength(1);
    const [, args] = exportCalls()[0] as [string, Record<string, unknown>];
    expect(args.extension).toBe('md');
    expect(args.filterLabel).toBe('Markdown Files');
    expect(args.defaultFileName).toBe('20261118-Release_planning-transcript.md');
    expect(clipboardWrites).toEqual(['/home/user/exports/20261118-Release_planning-transcript.md']);
    expect(successToast).toHaveBeenCalledWith('Transcript exported', {
      description: '/home/user/exports/20261118-Release_planning-transcript.md',
    });
  });
});
