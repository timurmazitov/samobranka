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
const { useFindReplace } = await import('../../src/hooks/meeting-details/useFindReplace');
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

function View({
  segments = SEGMENTS,
  summaryBlocks,
}: {
  segments?: TranscriptSegmentData[];
  summaryBlocks?: import('../../src/hooks/meeting-details/useFindReplace').SummaryBlock[];
}) {
  state = useFindReplace({ segments, summaryBlocks, loadAllPages });
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
      { key: 'transcript:s1:0', source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { key: 'transcript:s3:0', source: 'transcript', segmentId: 's3', from: 4, to: 9 },
      { key: 'transcript:s3:1', source: 'transcript', segmentId: 's3', from: 22, to: 27 },
      { key: 'summary:b1:0', source: 'summary', blockId: 'b1', from: 0, to: 5 },
      { key: 'summary:b2:0', source: 'summary', blockId: 'b2', from: 0, to: 5 },
      { key: 'summary:b2:1', source: 'summary', blockId: 'b2', from: 16, to: 21 },
    ]);
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
    expect(state.matches.map(m => m.key)).toEqual([
      'transcript:s3:0',
      'transcript:s3:1',
      'summary:b1:0',
      'summary:b2:0',
    ]);

    await setQuery('Alpha');
    // Capital «Alpha»: s1's leading word and the summary's «Alpha twice» —
    // both sources again, transcript first, per-block occurrence indexes
    // restart per block (b2's single case-sensitive hit is index 0).
    expect(state.matches).toEqual([
      { key: 'transcript:s1:0', source: 'transcript', segmentId: 's1', from: 0, to: 5 },
      { key: 'summary:b2:0', source: 'summary', blockId: 'b2', from: 16, to: 21 },
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
      { key: 'summary:b1:0', source: 'summary', blockId: 'b1', from: 6, to: 14 },
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
