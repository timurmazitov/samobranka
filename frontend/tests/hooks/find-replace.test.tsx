import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';
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
const { useFindReplace, ReplaceAllPartialFailureError, matchContainerId } = await import('../../src/hooks/meeting-details/useFindReplace');
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

function View({
  segments = SEGMENTS,
  summaryBlocks,
  onSummaryReplace,
}: {
  segments?: TranscriptSegmentData[];
  summaryBlocks?: import('../../src/hooks/meeting-details/useFindReplace').SummaryBlock[];
  onSummaryReplace?: (edits: import('../../src/lib/summary-find-replace').SummaryReplaceEdit[]) => void | Promise<void>;
}) {
  state = useFindReplace({ segments, summaryBlocks, loadAllPages, onSummaryReplace });
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

describe('useFindReplace combined transcript → summary list', () => {
  // The summary blocks as the summary surface would supply them (ticket 04):
  // one text per editor block, in display order.
  const SUMMARY_BLOCKS = [
    { blockId: 'b1', text: 'alpha overview' },
    { blockId: 'b2', text: 'alpha again and Alpha twice' },
  ];

  async function showWithSummary() {
    await act(async () => {
      renderer = create(<View summaryBlocks={SUMMARY_BLOCKS} />);
    });
  }

  test('the combined list is transcript matches first, then summary, on one counter', async () => {
    await showWithSummary();
    await setQuery('alpha');

    // SEGMENTS hit «alpha» in s1 (0..5) and twice in s3; the summary blocks
    // follow in their own order — one shared list, shared indices.
    expect(state.matches).toEqual([
      { source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { source: 'transcript', segmentId: 's3', from: 4, to: 9 },
      { source: 'transcript', segmentId: 's3', from: 22, to: 27 },
      { source: 'summary', blockId: 'b1', from: 0, to: 5 },
      { source: 'summary', blockId: 'b2', from: 0, to: 5 },
      { source: 'summary', blockId: 'b2', from: 16, to: 21 },
    ]);
    // The one container discriminator: segment ids on the transcript side,
    // block ids on the summary side.
    expect(state.matches.map(matchContainerId)).toEqual(['s1', 's3', 's3', 'b1', 'b2', 'b2']);
    expect(state.total).toBe(6);
    expect(state.current).toBe(1);
  });

  test('goNext crosses the transcript → summary boundary and cycles back', async () => {
    await showWithSummary();
    await setQuery('alpha');

    // Walk to the last transcript match…
    await act(async () => { state.goNext(); });
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(2); // s3's second hit, last transcript match
    expect(state.matches[state.activeIndex].source).toBe('transcript');

    // …then across the boundary into the summary side, counter shared.
    await act(async () => { state.goNext(); });
    expect(state.matches[state.activeIndex].source).toBe('summary');
    expect(state.matches[state.activeIndex].blockId).toBe('b1');
    expect(state.current).toBe(4);
    expect(state.total).toBe(6);

    await act(async () => { state.goNext(); });
    expect(state.matches[state.activeIndex].blockId).toBe('b2');
    await act(async () => { state.goNext(); });
    expect(state.matches[state.activeIndex].blockId).toBe('b2');
    // Past the end the list cycles to the first transcript match.
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(0);
    expect(state.matches[state.activeIndex].source).toBe('transcript');
  });

  test('goPrev crosses the summary → transcript boundary backwards', async () => {
    await showWithSummary();
    await setQuery('alpha');

    // From the first match, wrapping backwards lands on the LAST summary
    // match, and walking back through the summary reaches the transcript.
    await act(async () => { state.goPrev(); });
    expect(state.activeIndex).toBe(5);
    expect(state.matches[state.activeIndex].source).toBe('summary');
    await act(async () => { state.goPrev(); });
    expect(state.matches[state.activeIndex].source).toBe('summary');
    await act(async () => { state.goPrev(); });
    expect(state.matches[state.activeIndex].source).toBe('summary');
    expect(state.matches[state.activeIndex].blockId).toBe('b1');
    await act(async () => { state.goPrev(); });
    expect(state.matches[state.activeIndex].source).toBe('transcript');
  });

  test('the case toggle splits «Alpha» from «alpha» across both sources', async () => {
    await showWithSummary();
    await setQuery('alpha');
    expect(state.total).toBe(6); // case-insensitive by default

    await act(async () => { state.setCaseSensitive(true); });
    // Lowercase «alpha» only — s1's «Alpha» and the summary's «Alpha twice»
    // drop out; the toggle acts on the summary matches just like transcripts.
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual([
      'transcript:s3', 'transcript:s3', 'summary:b1', 'summary:b2',
    ]);

    await setQuery('Alpha');
    // Capital «Alpha»: s1's leading word and the summary's «Alpha twice» —
    // both sources again, transcript first.
    expect(state.matches).toEqual([
      { source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { source: 'summary', blockId: 'b2', from: 16, to: 21 },
    ]);
  });

  test('the whole-word toggle keeps a summary substring inside a longer word out', async () => {
    await showWithSummary();
    await setQuery('alph');
    expect(state.matches.map(m => m.source)).toEqual([
      'transcript', 'transcript', 'transcript', 'summary', 'summary', 'summary',
    ]); // substring hits every «alpha», both in b2…

    await act(async () => { state.setWholeWord(true); });
    // …and «alph» is never a whole word, so all six drop out at once —
    // the gate applies to the summary side exactly like the transcript side.
    expect(state.matches).toEqual([]);
    expect(state.noMatches).toBe(true);
  });

  test('summary-only matches navigate alone when the transcript has none', async () => {
    await showWithSummary();
    await setQuery('overview');
    expect(state.matches).toEqual([
      { source: 'summary', blockId: 'b1', from: 6, to: 14 },
    ]);
    expect(state.current).toBe(1);
    expect(state.total).toBe(1);
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(0);
  });

  test('without summary blocks the list stays transcript-only', async () => {
    await show();
    await setQuery('alpha');
    expect(state.matches.every(m => m.source === 'transcript')).toBe(true);
  });
});

describe('useFindReplace match list', () => {
  test('a query builds one match per occurrence across every loaded segment', async () => {
    await show();
    await setQuery('alpha');

    expect(state.matches).toEqual([
      { source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { source: 'transcript', segmentId: 's3', from: 4, to: 9 },
      { source: 'transcript', segmentId: 's3', from: 22, to: 27 },
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
      { source: 'transcript', segmentId: 's5', from: 0, to: 2 },
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
      { source: 'transcript', segmentId: 's2', from: 12, to: 16 },
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
      { source: 'transcript', segmentId: 't2', from: 12, to: 16 },
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
      { source: 'transcript', segmentId: 't1', from: 6, to: 10 },
      { source: 'transcript', segmentId: 't1', from: 11, to: 15 },
      { source: 'transcript', segmentId: 't2', from: 0, to: 4 },
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
    expect(state.matches[1]).toEqual({ source: 'transcript', segmentId: 't2', from: 0, to: 4 });
  });

  test('a rolled-back replacement never lands on the list head during the rollback window', async () => {
    // The restore-anchor flicker guard: between the failed save and the
    // arrival of the rolled-back text the list can recompute through states
    // that no longer contain the failed match (the host may take an extra
    // render to report the row back). The ordinary «new list → index 0»
    // reset must stay suppressed while the restore is pending, so the active
    // position never transiently lands on index 0 before the restore lands
    // back on the match the user could not save.
    await hosted();
    await setQuery('beta');
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1); // the t2 match

    let observedIndices: number[] = [];
    await act(async () => {
      state.setReplaceText('gamma');
      // Watch every commit between the click and the settled rollback: a
      // 0 here would be the flicker (index 0 is t1's still-present match).
      observedIndices = [];
    });
    await act(async () => { void state.replaceActive().catch(() => {}); });
    // The optimistic rewrite is in the state; the failure has not landed.
    observedIndices.push(state.activeIndex);
    await act(async () => { editRequests()[0].reject(new Error('database is locked')); });
    observedIndices.push(state.activeIndex);

    expect(observedIndices).not.toContain(0);
    // Settled: back on the t2 match, exactly as the plain rollback test pins.
    expect(state.activeIndex).toBe(1);
    expect(host.segments[1].text).toBe('beta mid and alpha tail');
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
      { source: 'transcript', segmentId: 't1', from: 6, to: 10 },
    ]);
    expect(state.activeIndex).toBe(0);
    // The caller is told exactly how many saves failed — with no raw text.
    expect(replaceAllError).toBeInstanceOf(ReplaceAllPartialFailureError);
    expect((replaceAllError as InstanceType<typeof ReplaceAllPartialFailureError>).failedCount).toBe(1);
  });
});

/**
 * Summary replacement at the hook seam (ticket 05): the hook plans edits in
 * block/offset space and hands them to the host's summary-replace path — the
 * summary surface that owns the live editor. The host here is a recorder: it
 * receives the planned SummaryReplaceEdit list and reports back whether the
 * edits applied (false = skipped, exactly the state after a host-side abort),
 * and the tests recompute the match list from the resulting blocks the same
 * way the real surface reports changed content up.
 */
describe('useFindReplace summary replacement', () => {
  const SUMMARY_BLOCKS = [
    { blockId: 'b1', text: 'alpha overview' },
    { blockId: 'b2', text: 'beta again and Alpha twice' },
  ];
  // Stable identities: a fresh literal per render would make the memoized
  // match list new on every render and the ordinary reset would keep
  // restarting navigation (the module-level SEGMENTS plays this role above).
  const NO_SEGMENTS: TranscriptSegmentData[] = [];

  let summaryCalls: SummaryReplaceEdit[][];
  let summaryApply: (edits: SummaryReplaceEdit[]) => boolean;
  // The blocks are React state: when the host applies the edits, the new
  // texts flow back into the hook exactly as the real summary surface
  // reports changed content up, and the match list recomputes.
  let setBlocksState: (
    update: { blockId: string; text: string }[]
      | ((current: { blockId: string; text: string }[]) => { blockId: string; text: string }[]),
  ) => void;

  function SummaryView() {
    const [blocks, setBlocks] = useState<{ blockId: string; text: string }[]>([]);
    setBlocksState = setBlocks;
    state = useFindReplace({
      segments: NO_SEGMENTS,
      summaryBlocks: blocks,
      onSummaryReplace: async (edits) => {
        summaryCalls.push(edits);
        const applied = summaryApply(edits);
        if (applied) {
          // The host applied the edits: right-to-left splice, the same text
          // the editor would now hold, reported up like the real surface does.
          setBlocks(current => current.map(block => {
            let text = block.text;
            const mine = edits.filter(edit => edit.blockId === block.blockId)
              .sort((a, b) => b.from - a.from);
            for (const edit of mine) {
              text = text.slice(0, edit.from) + edit.replacement + text.slice(edit.to);
            }
            return { ...block, text };
          }));
        }
        return applied;
      },
    });
    return null;
  }

  type SummaryReplaceEdit = import('../../src/lib/summary-find-replace').SummaryReplaceEdit;

  async function showSummary() {
    summaryCalls = [];
    summaryApply = () => true;
    await act(async () => { renderer = create(<SummaryView />); });
    await act(async () => { setBlocksState(SUMMARY_BLOCKS.map(block => ({ ...block }))); });
  }

  test('«Заменить» on a summary match sends one block/offset edit and advances', async () => {
    await showSummary();
    await setQuery('alpha');
    // b1's «alpha» first, then b2's «Alpha» (case-insensitive by default).
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual(['summary:b1', 'summary:b2']);
    expect(state.activeIndex).toBe(0);

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceActive(); });

    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]).toEqual([
      { blockId: 'b1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
    ]);

    // The recomputed list (from the new block text): only b2's match is left,
    // and navigation lands on it — the VS Code advance.
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual(['summary:b2']);
    expect(state.activeIndex).toBe(0);
    expect(state.current).toBe(1);
    expect(state.total).toBe(1);
  });

  test('replacing the last match of the list cycles; emptying it clears the position', async () => {
    await showSummary();
    await setQuery('alpha');
    await act(async () => { state.goNext(); });
    expect(state.activeIndex).toBe(1); // b2's «Alpha», the list's last match

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceActive(); });

    expect(summaryCalls[0]).toEqual([
      { blockId: 'b2', from: 15, to: 20, expected: 'Alpha', replacement: 'Zeta' },
    ]);
    // The replaced match was the list's last one; no match sits strictly
    // after its range, so navigation wraps to the surviving b1 match.
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual(['summary:b1']);
    expect(state.activeIndex).toBe(0);
    expect(state.current).toBe(1);
    expect(state.total).toBe(1);

    // And the match that used the list up entirely: no active position.
    await act(async () => { void state.replaceActive(); });
    expect(state.matches).toEqual([]);
    expect(state.activeIndex).toBe(-1);
    expect(state.current).toBe(0);
  });

  test('a no-op summary replace writes nothing but still advances', async () => {
    await showSummary();
    await setQuery('alpha');
    await act(async () => { state.setReplaceText('alpha'); });
    await act(async () => { void state.replaceActive(); });

    // Nothing to write (the field repeats the match) — but «Заменить» walks.
    expect(summaryCalls).toHaveLength(0);
    expect(state.activeIndex).toBe(1);
  });

  test('a skipped summary edit keeps the active position on the match', async () => {
    await showSummary();
    await setQuery('alpha');
    expect(state.activeIndex).toBe(0);

    // The host aborts (text changed under the range, its honesty gate): the
    // user keeps facing the match they could not replace.
    summaryApply = () => false;
    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceActive(); });

    expect(summaryCalls).toHaveLength(1);
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual(['summary:b1', 'summary:b2']);
    expect(state.activeIndex).toBe(0);
  });

  test('replace all covers transcript and summary together, one summary call', async () => {
    // The full meeting-page shape: real pagination host for the transcript,
    // the recording host for the summary, one combined list.
    let host: ReturnType<typeof usePaginatedTranscripts>;
    summaryCalls = [];
    summaryApply = () => {
      setBlocksState(current => current.map(block => ({
        ...block,
        text: block.text.replaceAll('beta', 'Zeta'),
      })));
      return true;
    };
    function Hosted() {
      const [blocks, setBlocks] = useState<{ blockId: string; text: string }[]>(
        [{ blockId: 'b1', text: 'beta overview and beta tail' }],
      );
      setBlocksState = setBlocks;
      host = usePaginatedTranscripts({ meetingId: 'M' });
      state = useFindReplace({
        segments: host.segments,
        summaryBlocks: blocks,
        loadAllPages: host.loadAllPages,
        onTextEdited: host.setTranscriptText,
        onSummaryReplace: async (edits) => {
          summaryCalls.push(edits);
          return summaryApply(edits);
        },
      });
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
        transcripts: [
          { id: 't1', text: 'beta lead', timestamp: '00:00', audio_start_time: 0 },
          { id: 't2', text: 'beta mid and beta tail', timestamp: '00:01', audio_start_time: 1 },
        ],
        total_count: 2,
        has_more: false,
      } satisfies PaginatedTranscriptsResponse);
    });
    await act(async () => { state.openPanel(); });
    await setQuery('beta');

    // 3 transcript matches + 2 summary matches: the shared counter and the
    // «Заменить все (N)» number now cover both sources.
    expect(state.total).toBe(5);
    expect(state.replaceableCount).toBe(5);

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceAll(); });

    // Transcript: one sequenced save per changed segment (existing path).
    const edits = requests.filter(r => r.command === 'api_update_transcript_text');
    expect(edits).toHaveLength(1);
    expect(edits[0].args).toEqual({ transcriptId: 't1', text: 'Zeta lead' });
    await act(async () => { edits[0].resolve({ message: 'ok' }); });
    expect(requests.filter(r => r.command === 'api_update_transcript_text')).toHaveLength(2);
    expect(requests.filter(r => r.command === 'api_update_transcript_text')[1].args)
      .toEqual({ transcriptId: 't2', text: 'Zeta mid and Zeta tail' });
    await act(async () => { requests.filter(r => r.command === 'api_update_transcript_text')[1].resolve({ message: 'ok' }); });

    // Summary: ONE call carrying both block edits, with expected texts.
    expect(summaryCalls).toHaveLength(1);
    expect(summaryCalls[0]).toEqual([
      { blockId: 'b1', from: 0, to: 4, expected: 'beta', replacement: 'Zeta' },
      { blockId: 'b1', from: 18, to: 22, expected: 'beta', replacement: 'Zeta' },
    ]);

    // Everything replaced: the recompute is empty across both sources.
    expect(state.matches).toEqual([]);
    expect(state.replaceableCount).toBe(0);
  });

  test('replace all with a skipped summary keeps its matches while the transcript saves', async () => {
    await showSummary();
    await setQuery('alpha');
    summaryApply = () => false; // the editor's honesty gate aborted the batch

    await act(async () => { state.setReplaceText('Zeta'); });
    await act(async () => { void state.replaceAll(); });

    // The skipped batch is not a failure toast-worthy event: no throw, and
    // the summary matches are still there because their text never changed.
    expect(summaryCalls).toHaveLength(1);
    expect(state.matches.map(m => `${m.source}:${matchContainerId(m)}`)).toEqual(['summary:b1', 'summary:b2']);
  });

  test('without a summary-replace path summary matches stay out of the replace-all count', async () => {
    // The combined navigation still lists them (ticket 04), but a match that
    // nothing can replace is never counted into «Заменить все (N)».
    await show();
    await act(async () => {
      renderer!.update(<View summaryBlocks={SUMMARY_BLOCKS} />);
    });
    await setQuery('alpha');
    expect(state.total).toBe(5); // 3 transcript + 2 summary
    expect(state.replaceableCount).toBe(3);
  });
});
