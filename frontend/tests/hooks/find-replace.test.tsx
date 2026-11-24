import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MeetingMetadata, PaginatedTranscriptsResponse, TranscriptSegmentData } from '../../src/types';

const originalCore = { ...await import('@tauri-apps/api/core') };
type Request = {
  command: string;
  args: Record<string, unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};
const requests: Request[] = [];
const invoke = mock((command: string, args: Record<string, unknown>) => new Promise((resolve, reject) => {
  requests.push({ command, args, resolve, reject });
}));
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
const { useFindReplace, ReplaceAllPartialFailureError } = await import('../../src/hooks/meeting-details/useFindReplace');
const { usePaginatedTranscripts } = await import('../../src/hooks/usePaginatedTranscripts');
afterAll(() => mock.module('@tauri-apps/api/core', () => originalCore));

/**
 * The find panel's seam: the hook owns the query, the toggles, the combined
 * match list and the active position, built from the meeting's loaded
 * segments. The wrapper supplies segments as plain data — matches are found
 * in the stored RAW text, so the highlight ranges stay honest once the rows
 * stop cleaning filler words while the panel is open.
 */
let state: ReturnType<typeof useFindReplace>;
let renderer: ReactTestRenderer | undefined;
const loadAllPages = mock(async () => {});

const SEGMENTS: TranscriptSegmentData[] = [
  { id: 's1', timestamp: 0, text: 'Alpha beta gamma' },
  { id: 's2', timestamp: 1, text: 'Beta again, Бета too' },
  { id: 's3', timestamp: 2, text: 'uh, alpha at the end: alpha' },
  { id: 's4', timestamp: 3, text: 'motor and motoring' },
];

type HostedSegment = { id: string; text: string; timestamp: string; audio_start_time: number };
const HOSTED_SEGMENTS: HostedSegment[] = [
  { id: 't1', text: 'Alpha beta gamma', timestamp: '00:00', audio_start_time: 0 },
  { id: 't2', text: 'beta mid and alpha tail', timestamp: '00:01', audio_start_time: 1 },
];

function View({ segments = SEGMENTS }: { segments?: TranscriptSegmentData[] }) {
  state = useFindReplace({ segments, loadAllPages });
  return <output>{state.matches.length}:{state.activeIndex}</output>;
}

beforeEach(() => {
  requests.length = 0;
  invoke.mockClear();
  loadAllPages.mockClear();
  mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function show() {
  await act(async () => {
    renderer = create(<View />);
  });
}

async function setQuery(query: string) {
  await act(async () => { state.setQuery(query); });
}

describe('useFindReplace match list', () => {
  test('a query builds one match per occurrence across every loaded segment', async () => {
    await show();
    await setQuery('alpha');

    expect(state.matches).toEqual([
      { key: 'transcript:s1:0', source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { key: 'transcript:s3:0', source: 'transcript', segmentId: 's3', from: 4, to: 9 },
      { key: 'transcript:s3:1', source: 'transcript', segmentId: 's3', from: 22, to: 27 },
    ]);
    expect(state.activeIndex).toBe(0);
    expect(state.noMatches).toBe(false);
    // The counter the panel renders: 1-based current over the total.
    expect(state.current).toBe(1);
    expect(state.total).toBe(3);
  });

  test('matches are found in a segment the cleaned display would empty', async () => {
    // «uh,» is the whole raw text; the cleaned display falls back to the
    // silence label, but the stored text still holds the match — the panel
    // matches on what is persisted, and shows rows raw while it is open.
    await show();
    await act(async () => {
      renderer!.update(<View segments={[{ id: 's5', timestamp: 0, text: 'uh,' }]} />);
    });
    await setQuery('uh');

    expect(state.matches).toEqual([
      { key: 'transcript:s5:0', source: 'transcript', segmentId: 's5', from: 0, to: 2 },
    ]);
  });

  test('the case toggle is off by default and splits «Бета» from «бета» when on', async () => {
    await show();
    expect(state.caseSensitive).toBe(false);
    await setQuery('бета');
    expect(state.matches.map(m => [m.segmentId, m.from])).toEqual([['s2', 12]]);

    await act(async () => { state.setCaseSensitive(true); });
    expect(state.matches).toEqual([]);
    expect(state.current).toBe(0);
    expect(state.total).toBe(0);
    expect(state.noMatches).toBe(true);

    await setQuery('Бета');
    expect(state.matches).toEqual([
      { key: 'transcript:s2:0', source: 'transcript', segmentId: 's2', from: 12, to: 16 },
    ]);
  });

  test('the whole-word toggle keeps a substring inside a longer word out', async () => {
    await show();
    await setQuery('motor');
    // Substring by default: «motor» also inside «motoring».
    expect(state.matches.map(m => [m.segmentId, m.from])).toEqual([['s4', 0], ['s4', 10]]);

    await act(async () => { state.setWholeWord(true); });
    expect(state.matches.map(m => [m.segmentId, m.from])).toEqual([['s4', 0]]);

    await setQuery('moto');
    expect(state.matches).toEqual([]);
  });

  test('changing the query or a toggle restarts navigation at the first match', async () => {
    await show();
    await setQuery('beta');
    expect(state.activeIndex).toBe(0);
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1);

    await setQuery('alpha');
    expect(state.activeIndex).toBe(0);
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1);
    await act(async () => { state.setCaseSensitive(true); });
    expect(state.activeIndex).toBe(0);
  });

  test('an empty or whitespace query lists no matches and is not an error', async () => {
    await show();
    await setQuery('beta');
    expect(state.total).toBe(2); // Latin «Beta» in s1 and s2; Cyrillic «Бета» is another script

    await setQuery('');
    expect(state.matches).toEqual([]);
    expect(state.hasQuery).toBe(false);
    expect(state.noMatches).toBe(false);
    expect(state.current).toBe(0);
    expect(state.total).toBe(0);

    await setQuery('   ');
    expect(state.matches).toEqual([]);
    expect(state.hasQuery).toBe(false);
    expect(state.noMatches).toBe(false);
  });

  test('a query with no hits is the zero state, distinct from an empty query', async () => {
    await show();
    await setQuery('zebra');
    expect(state.matches).toEqual([]);
    expect(state.hasQuery).toBe(true);
    expect(state.noMatches).toBe(true);
    expect(state.current).toBe(0);
    expect(state.total).toBe(0);
    expect(state.activeIndex).toBe(-1);
  });
});

describe('useFindReplace navigation', () => {
  test('goNext and goPrev cycle through the combined list', async () => {
    await show();
    await setQuery('alpha');
    expect(state.activeIndex).toBe(0);

    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1);
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(2);
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(0);

    await act(async () => { state.goPrev(); });
    expect(state.activeIndex).toBe(2);
    expect(state.current).toBe(3);
    expect(state.total).toBe(3);
  });

  test('navigation is inert without matches', async () => {
    await show();
    await setQuery('zebra');
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(-1);
    await act(async () => { state.goPrev(); });
    expect(state.activeIndex).toBe(-1);
  });
});

describe('useFindReplace panel lifecycle', () => {
  test('closing clears the query, the matches and the open state', async () => {
    await show();
    await setQuery('alpha');
    await act(async () => { state.closePanel(); });

    expect(state.open).toBe(false);
    expect(state.query).toBe('');
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
    expect(state.hasQuery).toBe(false);
    expect(state.noMatches).toBe(false);
  });

  test('opening and closing again leaves no query behind', async () => {
    await show();
    await setQuery('beta');
    await act(async () => { state.closePanel(); });
    await act(async () => { state.openPanel(); });
    expect(state.query).toBe('');
    expect(state.matches).toEqual([]);

    await act(async () => { state.closePanel(); });
    expect(state.open).toBe(false);
  });

  test('the first open asks the host to load every segment page exactly once', async () => {
    await show();
    expect(loadAllPages).not.toHaveBeenCalled();

    await act(async () => { state.openPanel(); });
    expect(loadAllPages).toHaveBeenCalledTimes(1);

    await act(async () => { state.closePanel(); });
    await act(async () => { state.openPanel(); });
    expect(loadAllPages).toHaveBeenCalledTimes(1);
  });

  test('the replace field focus request reaches the panel', async () => {
    await show();
    expect(state.focusTarget).toBe('search');
    await act(async () => { state.openPanel({ focus: 'replace' }); });
    expect(state.focusTarget).toBe('replace');
    expect(state.focusNonce).toBe(1);

    await act(async () => { state.closePanel(); });
    await act(async () => { state.openPanel({ focus: 'replace' }); });
    expect(state.focusTarget).toBe('replace');
    expect(state.focusNonce).toBe(2);
  });
});

describe('useFindReplace with the paginated host', () => {
  test('opening loads every page so matches cover not-yet-loaded segments', async () => {
    // Same composition as the meeting page: the hook receives the pagination
    // hook's segments and its loadAllPages, so the first open must pull the
    // second page into the state the matches are built from.
    let host: ReturnType<typeof usePaginatedTranscripts>;
    function Hosted() {
      host = usePaginatedTranscripts({ meetingId: 'M' });
      state = useFindReplace({ segments: host.segments, loadAllPages: host.loadAllPages });
      return null;
    }

    await act(async () => { renderer = create(<Hosted />); });
    const metadata = requests.find(r => r.command === 'api_get_meeting_metadata');
    expect(metadata).toBeDefined();
    await act(async () => {
      metadata!.resolve({ id: 'M', title: 'M', created_at: '2026-09-07', updated_at: '2026-09-07' } satisfies MeetingMetadata);
    });
    const firstPage = requests.find(r => r.command === 'api_get_meeting_transcripts');
    expect(firstPage).toBeDefined();
    await act(async () => {
      firstPage!.resolve({
        transcripts: [{ id: 't1', text: 'first page alpha', timestamp: '00:00', audio_start_time: 0 }],
        total_count: 2,
        has_more: true,
      } satisfies PaginatedTranscriptsResponse);
    });

    // First open: the remaining pages start loading through the pagination
    // hook's own mechanism (same offset bookkeeping as loadMore).
    await act(async () => { state.openPanel(); });
    const secondPage = requests.filter(r =>
      r.command === 'api_get_meeting_transcripts' && r.args.offset === 1,
    );
    expect(secondPage).toHaveLength(1);
    expect(secondPage[0].args).toMatchObject({ meetingId: 'M', limit: 100 });

    await setQuery('alpha');
    expect(state.matches.map(m => m.segmentId)).toEqual(['t1']);

    await setQuery('beta');
    expect(state.matches).toEqual([]);
    await act(async () => {
      secondPage[0].resolve({
        transcripts: [{ id: 't2', text: 'second page beta', timestamp: '00:01', audio_start_time: 1 }],
        total_count: 2,
        has_more: false,
      } satisfies PaginatedTranscriptsResponse);
    });

    // The newly loaded page joins the same match list.
    expect(state.matches).toEqual([
      { key: 'transcript:t2:0', source: 'transcript', segmentId: 't2', from: 12, to: 16 },
    ]);
    // Nothing more to load: the loop stops when the backend says so.
    expect(requests.filter(r => r.command === 'api_get_meeting_transcripts')).toHaveLength(2);
  });
});

/**
 * Replacement tests run through the real composition the meeting page uses:
 * the pagination hook owns the segments (optimistic text updates and rollback
 * included) and the find hook receives them plus the page-content save
 * callback, so a replace must go through `api_update_transcript_text` exactly
 * like the row editor does — never through a second save path.
 */
describe('useFindReplace replacement', () => {
  let host: ReturnType<typeof usePaginatedTranscripts>;
  function Hosted() {
    host = usePaginatedTranscripts({ meetingId: 'M' });
    state = useFindReplace({
      segments: host.segments,
      loadAllPages: host.loadAllPages,
      onTextEdited: host.setTranscriptText,
    });
    return null;
  }

  async function hosted(
    texts: Partial<Record<'t1' | 't2', string>> = {},
  ) {
    await act(async () => { renderer = create(<Hosted />); });
    const metadata = requests.find(r => r.command === 'api_get_meeting_metadata');
    expect(metadata).toBeDefined();
    await act(async () => {
      metadata!.resolve({ id: 'M', title: 'M', created_at: '2026-09-07', updated_at: '2026-09-07' } satisfies MeetingMetadata);
    });
    const firstPage = requests.find(r => r.command === 'api_get_meeting_transcripts');
    expect(firstPage).toBeDefined();
    await act(async () => {
      firstPage!.resolve({
        transcripts: HOSTED_SEGMENTS.map(s => ({ ...s, text: texts[s.id as 't1' | 't2'] ?? s.text })),
        total_count: HOSTED_SEGMENTS.length,
        has_more: false,
      } satisfies PaginatedTranscriptsResponse);
    });
    await act(async () => { state.openPanel(); });
  }

  function editRequests() {
    return requests.filter(r => r.command === 'api_update_transcript_text');
  }

  test('replacing the active match saves the segment text and advances to the next match', async () => {
    await hosted();
    await setQuery('beta');
    expect(state.matches.map(m => m.segmentId)).toEqual(['t1', 't2']);
    expect(state.activeIndex).toBe(0);

    await act(async () => { state.setReplaceText('Zeta'); });
    let replaceError: unknown = null;
    await act(async () => { void state.replaceActive().catch(error => { replaceError = error; }); });

    const edits = editRequests();
    expect(edits).toHaveLength(1);
    expect(edits[0].args).toEqual({ transcriptId: 't1', text: 'Alpha Zeta gamma' });
    await act(async () => { edits[0].resolve({ message: 'ok' }); });
    expect(replaceError).toBe(null);

    // VS Code behavior: focus moves to the next match — here the only
    // remaining one (the t2 «beta» after the replaced «alpha» tail).
    expect(state.matches.map(m => m.segmentId)).toEqual(['t2']);
    expect(state.activeIndex).toBe(0);
    expect(state.current).toBe(1);
    expect(state.total).toBe(1);
  });

  test('a replacement whose text re-matches leaves a sane list and lands past the written text', async () => {
    await hosted();
    await setQuery('beta');
    expect(state.total).toBe(2);

    // «beta beta» still contains the query: after the save the segment holds
    // two fresh matches, and the list must recompute from the real text —
    // active lands on the one after the text just written, never a stale
    // range into the old text.
    await act(async () => { state.setReplaceText('beta beta'); });
    await act(async () => { void state.replaceActive(); });

    const edits = editRequests();
    expect(edits).toHaveLength(1);
    expect(edits[0].args).toEqual({ transcriptId: 't1', text: 'Alpha beta beta gamma' });
    await act(async () => { edits[0].resolve({ message: 'ok' }); });

    expect(state.matches).toEqual([
      { key: 'transcript:t1:0', source: 'transcript', segmentId: 't1', from: 6, to: 10 },
      { key: 'transcript:t1:1', source: 'transcript', segmentId: 't1', from: 11, to: 15 },
      { key: 'transcript:t2:0', source: 'transcript', segmentId: 't2', from: 0, to: 4 },
    ]);
    expect(state.activeIndex).toBe(1);
  });

  test('replace all saves once per changed segment with every match spliced out', async () => {
    await hosted({ t2: 'beta mid and beta tail' });
    // «beta» in t1 once, t2 twice — three matches over two segments.
    await setQuery('beta');
    expect(state.total).toBe(3);
    expect(state.replaceableCount).toBe(3);

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceAll(); });

    const edits = editRequests();
    // The saves are sequenced, not parallel: only the first is in flight; the
    // second starts once the first settles.
    expect(edits).toHaveLength(1);
    // All of the segment's ranges splice out of the raw text at once.
    expect(edits[0].args).toEqual({ transcriptId: 't1', text: 'Alpha Zeta gamma' });
    await act(async () => { edits[0].resolve({ message: 'ok' }); });
    expect(editRequests()).toHaveLength(2);
    expect(editRequests()[1].args).toEqual({ transcriptId: 't2', text: 'Zeta mid and Zeta tail' });
    await act(async () => { editRequests()[1].resolve({ message: 'ok' }); });

    // Every match replaced: nothing survives the recompute.
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
  });

  test('an empty replace field deletes the matched text', async () => {
    await hosted();
    await setQuery('beta');

    // The field is left empty — «Заменить» must delete the match, exactly as
    // replacing with nothing in an editor does.
    await act(async () => { void state.replaceActive(); });

    const edits = editRequests();
    expect(edits).toHaveLength(1);
    expect(edits[0].args).toEqual({ transcriptId: 't1', text: 'Alpha gamma' });
    await act(async () => { edits[0].resolve({ message: 'ok' }); });
    expect(state.matches.map(m => m.segmentId)).toEqual(['t2']);
    expect(state.activeIndex).toBe(0);
  });

  test('a replace with nothing to replace invokes no save', async () => {
    await hosted();
    await setQuery('zebra');
    expect(state.noMatches).toBe(true);

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { await state.replaceActive(); });
    await act(async () => { await state.replaceAll(); });

    expect(editRequests()).toHaveLength(0);
  });

  test('a failed single replace keeps the active match on the rolled-back text', async () => {
    await hosted();
    await setQuery('beta');
    expect(state.activeIndex).toBe(0);

    await act(async () => { state.setReplaceText('Zeta'); });
    let replaceError: unknown = null;
    await act(async () => {
      void state.replaceActive().catch(error => { replaceError = error; });
    });

    const edits = editRequests();
    expect(edits).toHaveLength(1);
    // The host's rollback path: the optimistic row text comes back, the error
    // rethrows. The find state must follow the actual text, not the fantasy.
    await act(async () => { edits[0].reject(new Error('database is locked')); });

    // Same text, same match list, same active position — the user sees the
    // match they could not replace still in front of them, and the caller is
    // told the save failed (the panel toasts, like the row editor does).
    expect(String(replaceError)).toContain('database is locked');
    expect(host.segments[0].text).toBe('Alpha beta gamma');
    expect(state.matches.map(m => m.segmentId)).toEqual(['t1', 't2']);
    expect(state.activeIndex).toBe(0);
  });

  test('a failed replace of a later match lands back on that match, not the list head', async () => {
    await hosted();
    await setQuery('beta');
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1); // the t2 match

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceActive().catch(() => {}); });
    await act(async () => { editRequests()[0].reject(new Error('database is locked')); });

    // The optimistic t2 rewrite was rolled back; the active position returns
    // to that same match rather than jumping to the list head.
    expect(state.matches.map(m => m.segmentId)).toEqual(['t1', 't2']);
    expect(state.activeIndex).toBe(1);
    expect(state.matches[1]).toEqual({ key: 'transcript:t2:0', source: 'transcript', segmentId: 't2', from: 0, to: 4 });
  });

  test('replace all with one failed segment leaves only that segment\'s matches', async () => {
    await hosted({ t2: 'beta mid and beta tail' });
    await setQuery('beta');

    await act(async () => { state.setReplaceText('Zeta'); });
    let replaceAllError: unknown = null;
    let replaceAllDone = false;
    await act(async () => {
      void state.replaceAll()
        .catch(error => { replaceAllError = error; })
        .finally(() => { replaceAllDone = true; });
    });

    // The first save fails (rolls back t1), the second one lands.
    await act(async () => { editRequests()[0].reject(new Error('database is locked')); });
    expect(editRequests()).toHaveLength(2);
    await act(async () => { editRequests()[1].resolve({ message: 'ok' }); });
    expect(replaceAllDone).toBe(true);

    // t1 is rolled back to its original text with its match; t2's text holds
    // no «beta» and drops out of the list. No stale ranges survive either way.
    expect(host.segments.map(s => s.text)).toEqual(['Alpha beta gamma', 'Zeta mid and Zeta tail']);
    expect(state.matches).toEqual([
      { key: 'transcript:t1:0', source: 'transcript', segmentId: 't1', from: 6, to: 10 },
    ]);
    expect(state.activeIndex).toBe(0);
    // The caller is told exactly how many saves failed — with no raw text.
    expect(replaceAllError).toBeInstanceOf(ReplaceAllPartialFailureError);
    expect((replaceAllError as InstanceType<typeof ReplaceAllPartialFailureError>).failedCount).toBe(1);
  });
});
