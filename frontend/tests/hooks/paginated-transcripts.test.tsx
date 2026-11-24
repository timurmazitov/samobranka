import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { MeetingMetadata, PaginatedTranscriptsResponse } from '../../src/types';

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
const { usePaginatedTranscripts } = await import('../../src/hooks/usePaginatedTranscripts');
afterAll(() => mock.module('@tauri-apps/api/core', () => originalCore));

let state: ReturnType<typeof usePaginatedTranscripts>;
let renderer: ReactTestRenderer | undefined;
function View({ meetingId }: { meetingId: string | null }) {
  state = usePaginatedTranscripts({ meetingId });
  return <output>{state.metadata?.id}:{state.transcripts.map(t => t.text).join(',')}</output>;
}
beforeEach(() => {
  requests.length = 0;
  invoke.mockClear();
  mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});
async function show(meetingId: string | null) {
  await act(async () => {
    if (renderer) renderer.update(<View meetingId={meetingId} />);
    else renderer = create(<View meetingId={meetingId} />);
  });
}
function request(command: 'metadata' | 'transcripts', meetingId: string, index = 0) {
  const result = requests.filter(r => r.command === `api_get_meeting_${command}` && r.args.meetingId === meetingId)[index];
  expect(result).toBeDefined();
  return result;
}
function editRequest(transcriptId: string, index = 0) {
  const result = requests.filter(r => r.command === 'api_update_transcript_text' && r.args.transcriptId === transcriptId)[index];
  expect(result).toBeDefined();
  return result;
}
function deleteRequest(meetingId: string, index = 0) {
  const result = requests.filter(r => r.command === 'api_delete_transcripts' && r.args.meetingId === meetingId)[index];
  expect(result).toBeDefined();
  return result;
}
const metadata = (id: string): MeetingMetadata => ({ id, title: id, created_at: '2026-09-07', updated_at: '2026-09-07' });
const page = (text: string, hasMore = false): PaginatedTranscriptsResponse => ({
  transcripts: [{ id: text, text, timestamp: '00:00', audio_start_time: 0 }],
  total_count: hasMore ? 2 : 1, has_more: hasMore,
});
async function resolve(req: Request, value: unknown) {
  await act(async () => { req.resolve(value); });
}
async function load(meetingId: string, hasMore = false) {
  await show(meetingId);
  await resolve(request('metadata', meetingId), metadata(meetingId));
  await resolve(request('transcripts', meetingId), page(meetingId, hasMore));
}

describe('paginated transcript request ownership', () => {
  test('ignores late A metadata after B finishes and does not start A transcripts', async () => {
    await show('A');
    const stale = request('metadata', 'A');
    await load('B');
    await resolve(stale, metadata('A'));
    expect(state.metadata?.id).toBe('B');
    expect(state.transcripts[0].text).toBe('B');
    expect(state.isLoading).toBe(false);
    expect(requests.filter(r => r.command === 'api_get_meeting_transcripts' && r.args.meetingId === 'A')).toHaveLength(0);
  });

  test('late A transcripts cannot replace B or finish its loading state', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    const stale = request('transcripts', 'A');
    await show('B');
    await resolve(stale, page('A'));
    expect(state.isLoading).toBe(true);
    expect(state.transcripts).toEqual([]);
    await resolve(request('metadata', 'B'), metadata('B'));
    await resolve(request('transcripts', 'B'), page('B'));
    expect(state.metadata?.id).toBe('B');
    expect(state.transcripts[0].text).toBe('B');
  });

  test('returning A to B to A does not revive the first A request', async () => {
    await show('A');
    const stale = request('metadata', 'A');
    await show('B');
    await show('A');
    await resolve(request('metadata', 'A', 1), { ...metadata('A'), title: 'Current A' });
    await resolve(request('transcripts', 'A'), page('Current A'));
    await resolve(stale, { ...metadata('A'), title: 'Old A' });
    expect(state.metadata?.title).toBe('Current A');
    expect(state.transcripts[0].text).toBe('Current A');
    expect(state.isLoading).toBe(false);
    expect(requests.filter(r => r.command === 'api_get_meeting_transcripts' && r.args.meetingId === 'A')).toHaveLength(1);
  });

  test('a stale failure cannot add an error or clear current loading', async () => {
    await show('A');
    const stale = request('metadata', 'A');
    await show('B');
    await act(async () => { stale.reject(new Error('A unavailable')); });
    expect(state.error).toBeNull();
    expect(state.isLoading).toBe(true);
  });

  test('newest refetch wins over an earlier request for the same meeting', async () => {
    await load('A');
    await act(async () => { void state.refetch(); });
    await resolve(request('metadata', 'A', 1), metadata('A'));
    const stale = request('transcripts', 'A', 1);
    await act(async () => { void state.refetch(); });
    await resolve(request('metadata', 'A', 2), metadata('A'));
    await resolve(request('transcripts', 'A', 2), page('newest'));
    await resolve(stale, page('stale'));
    expect(state.transcripts[0].text).toBe('newest');
    expect(state.isLoading).toBe(false);
  });

  test('old loadMore cannot append data or clear the next meeting loadMore lock', async () => {
    await load('A', true);
    await act(async () => { void state.loadMore(); });
    const stale = request('transcripts', 'A', 1);
    await load('B', true);
    await act(async () => { void state.loadMore(); });
    const current = request('transcripts', 'B', 1);
    await resolve(stale, page('old extra'));
    expect(state.isLoadingMore).toBe(true);
    expect(state.transcripts.map(t => t.text)).toEqual(['B']);
    await resolve(current, page('B extra'));
    expect(state.isLoadingMore).toBe(false);
    expect(state.transcripts.map(t => t.text)).toEqual(['B', 'B extra']);
  });

  test('reset invalidates pending reads and null to same meeting reloads', async () => {
    await show('A');
    const stale = request('metadata', 'A');
    await act(async () => { state.reset(); });
    await resolve(stale, metadata('A'));
    expect(state.metadata).toBeNull();
    await show(null);
    await show('A');
    await resolve(request('metadata', 'A', 1), metadata('A'));
    await resolve(request('transcripts', 'A'), page('fresh'));
    expect(state.transcripts[0].text).toBe('fresh');
  });

  test('unmount prevents a pending metadata read from starting transcript IPC', async () => {
    await show('A');
    const stale = request('metadata', 'A');
    await act(async () => { renderer!.unmount(); });
    renderer = undefined;
    await resolve(stale, metadata('A'));
    expect(requests).toHaveLength(1);
  });

  test('segments carry the assigned speaker name of each transcript', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), {
      transcripts: [
        { id: 't1', text: 'Named', timestamp: '00:00', audio_start_time: 0, speaker: 'speaker_0', speaker_name: 'Alex' },
        { id: 't2', text: 'Unnamed', timestamp: '00:01', audio_start_time: 1, speaker: 'speaker_1' },
      ],
      total_count: 2, has_more: false,
    });
    expect(state.segments.map(s => [s.speaker, s.speaker_name])).toEqual([
      ['speaker_0', 'Alex'],
      ['speaker_1', undefined],
    ]);
  });

  test('a row edit is visible in the segments before the next refetch', async () => {
    await load('A');
    await act(async () => { state.setTranscriptSpeaker('A', 'speaker_1', 'Maria'); });
    expect(state.segments[0]).toMatchObject({ speaker: 'speaker_1', speaker_name: 'Maria' });
    await act(async () => { state.setTranscriptSpeaker('A', null); });
    expect(state.segments[0]).toMatchObject({ speaker: undefined, speaker_name: undefined });
  });

  test('a row text edit is visible in the segments before the save is answered', async () => {
    await load('A');
    await act(async () => { void state.setTranscriptText('A', 'Fixed words'); });
    // The optimistic value lands in the segments while the save is still open.
    expect(state.segments[0].text).toBe('Fixed words');
    const save = editRequest('A');
    await resolve(save, { message: 'Transcript text saved successfully' });
    expect(state.segments[0].text).toBe('Fixed words');
  });

  test('a rejected text edit rolls the row back to its previous text', async () => {
    await load('A');
    let failure: unknown = null;
    await act(async () => {
      void state.setTranscriptText('A', 'Never stored').catch(error => { failure = error; });
    });
    expect(state.segments[0].text).toBe('Never stored');

    await act(async () => { editRequest('A').reject(new Error('database is locked')); });

    // The hook owns the rollback and rethrows so the row can toast; the test
    // catches the rejection to keep it from escaping as an unhandled error.
    expect(state.segments[0].text).toBe('A');
    expect(String(failure)).toContain('database is locked');
  });

  test('a pasted multi-line draft saves and shows collapsed', async () => {
    await load('A');
    await act(async () => { void state.setTranscriptText('A', '  first  line\n\tsecond   line  '); });
    expect(state.segments[0].text).toBe('first line second line');
    expect(editRequest('A').args).toEqual({
      transcriptId: 'A',
      text: 'first line second line',
    });
    await resolve(editRequest('A'), { message: 'ok' });
    expect(state.segments[0].text).toBe('first line second line');
  });

  test('an empty edit reaches the backend without blanking the row', async () => {
    // The repository is the authority that rejects an empty line, so the save
    // attempt goes out — but the row is never optimistically blanked.
    await load('A');
    let failure: unknown = null;
    await act(async () => {
      void state.setTranscriptText('A', '  \n ').catch(error => { failure = error; });
    });
    expect(state.segments[0].text).toBe('A');
    expect(editRequest('A').args).toEqual({ transcriptId: 'A', text: '' });

    await act(async () => {
      editRequest('A').reject(new Error('transcript text cannot be empty'));
    });

    expect(state.segments[0].text).toBe('A');
    expect(String(failure)).toContain('cannot be empty');
  });

  // --- segment deletion (ticket 01) ---------------------------------------
  //
  // The delete method is the single path both the hover trash (single) and
  // the bulk toolbar (ticket 02) use, so it takes a list of ids from the
  // start. The tests below pin the optimistic removal, the rollback, the
  // totalCount/has_more honesty and the offset correction that keeps
  // loadMore from skipping shifted-in rows.

  const row = (id: string, start: number) => ({
    id, text: id, timestamp: '00:00', audio_start_time: start,
  });
  // `startAt` keeps every row's audio_start_time unique across pages, so the
  // hook's sort order (and the assertions) follow the load order.
  const manyPage = (ids: string[], total: number, hasMore: boolean, startAt = 0): PaginatedTranscriptsResponse => ({
    transcripts: ids.map((id, index) => row(id, startAt + index)),
    total_count: total, has_more: hasMore,
  });

  test('a delete removes the row from the segments before the backend answers', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2', 't3'], 3, false));

    await act(async () => { void state.deleteTranscripts(['t2']); });

    // The optimistic value lands while the delete is still open.
    expect(state.segments.map(s => s.id)).toEqual(['t1', 't3']);
    expect(state.totalCount).toBe(2);
    await resolve(deleteRequest('A'), { message: 'Transcript segments deleted successfully' });
    expect(state.segments.map(s => s.id)).toEqual(['t1', 't3']);
  });

  test('the delete command carries the meeting and the requested ids', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2', 't3'], 3, false));

    await act(async () => { void state.deleteTranscripts(['t1', 't3']); });

    expect(deleteRequest('A').args).toEqual({ meetingId: 'A', ids: ['t1', 't3'] });
    await resolve(deleteRequest('A'), { message: 'ok' });
  });

  test('a rejected delete rolls the rows and the counter back', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2', 't3'], 3, false));

    let failure: unknown = null;
    await act(async () => {
      void state.deleteTranscripts(['t1', 't3']).catch(error => { failure = error; });
    });
    expect(state.segments.map(s => s.id)).toEqual(['t2']);
    expect(state.totalCount).toBe(1);

    await act(async () => { deleteRequest('A').reject(new Error('transcript not found: t3')); });

    // Rows return in their original order and the counter recovers, so the
    // page never diverges from the database after a failed delete.
    expect(state.segments.map(s => s.id)).toEqual(['t1', 't2', 't3']);
    expect(state.totalCount).toBe(3);
    expect(String(failure)).toContain('transcript not found');
  });

  test('after a delete the has-more flag stays honest', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    // The server said "more" at a total this page already covers; after the
    // delete, loadedCount === totalCount, so has_more must drop.
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 2, true));
    expect(state.hasMore).toBe(true);

    await act(async () => { void state.deleteTranscripts(['t1']); });
    await resolve(deleteRequest('A'), { message: 'ok' });

    expect(state.totalCount).toBe(1);
    expect(state.loadedCount).toBe(1);
    expect(state.hasMore).toBe(false);
  });

  test('after a delete the next page continues where the rows shifted to', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 4, true));

    await act(async () => { void state.deleteTranscripts(['t1']); });
    await resolve(deleteRequest('A'), { message: 'ok' });

    await act(async () => { void state.loadMore(); });
    const second = request('transcripts', 'A', 1);
    // One loaded row was removed, so the server window moved back by one:
    // asking for the stale offset 2 would silently skip the row that slid in.
    expect(second.args.offset).toBe(1);
    await resolve(second, manyPage(['t3', 't4'], 4, false, 2));
    expect(state.transcripts.map(t => t.id)).toEqual(['t2', 't3', 't4']);
  });

  // Ticket 02: the bulk toolbar refetches the current window after the
  // batch lands, so the rows that slid into the freed places show up without
  // waiting for a loadMore (offset pagination never skips a shifted row).

  test('a bulk delete reloads the window so the shifted rows appear', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    // Two loaded of four; deleting both opens two places for the tail rows.
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 4, true));

    await act(async () => {
      void state.deleteTranscripts(['t1', 't2'], { refetchWindow: true });
    });
    await resolve(deleteRequest('A'), { message: 'ok' });

    // The window reload asks from 0 (the loaded list always starts at the
    // transcript's beginning) with at least a page — never a stale mid-list
    // offset, which would silently skip the rows that slid back.
    const windowReload = request('transcripts', 'A', 1);
    expect(windowReload.args).toEqual({ meetingId: 'A', limit: 100, offset: 0 });
    await resolve(windowReload, manyPage(['t3', 't4'], 2, false, 2));
    expect(state.segments.map(s => s.id)).toEqual(['t3', 't4']);
    expect(state.totalCount).toBe(2);
    expect(state.hasMore).toBe(false);
  });

  test('a partial bulk delete reloads the whole window, not a truncated page', async () => {
    // A multi-page-loaded window must be re-read whole: asking a default
    // 100-row page at offset 0 and replacing would truncate it.
    const loaded = Array.from({ length: 120 }, (_, i) => `t${i}`);
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(loaded, 130, true));

    await act(async () => {
      void state.deleteTranscripts(['t60'], { refetchWindow: true });
    });
    await resolve(deleteRequest('A'), { message: 'ok' });

    const windowReload = request('transcripts', 'A', 1);
    // 119 rows remained loaded, so the reload asks for 119 (>= the page size),
    // not 100 — a 100-row replacement would drop the last 19 loaded rows.
    expect(windowReload.args).toEqual({ meetingId: 'A', limit: 119, offset: 0 });
  });

  test('a failed bulk window reload keeps the honest optimistic counters', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 4, true));

    await act(async () => {
      void state.deleteTranscripts(['t1', 't2'], { refetchWindow: true });
    });
    await resolve(deleteRequest('A'), { message: 'ok' });

    // The reload cannot reach the backend: the deleted rows must NOT return
    // and the decremented counter must survive the failed read.
    await act(async () => { request('transcripts', 'A', 1).reject(new Error('offline')); });
    expect(state.segments.map(s => s.id)).toEqual([]);
    expect(state.totalCount).toBe(2);
  });

  test('a refetch failure after a successful bulk delete does not surface as a hook error', async () => {
    // The delete itself committed; only the window re-read failed. The
    // promise must still resolve — the page clears the selection and fires
    // the stale-summary hint on a resolved delete — and the failure must be
    // logged, not raised as a hook error: the page turns that into its
    // full-screen error and would undo the successful delete's UI.
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      await show('A');
      await resolve(request('metadata', 'A'), metadata('A'));
      await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 4, true));

      let failure: unknown = null;
      await act(async () => {
        void state.deleteTranscripts(['t1', 't2'], { refetchWindow: true }).catch(error => { failure = error; });
      });
      await resolve(deleteRequest('A'), { message: 'ok' });

      await act(async () => { request('transcripts', 'A', 1).reject(new Error('offline')); });

      expect(failure).toBeNull();
      expect(state.segments.map(s => s.id)).toEqual([]);
      expect(state.totalCount).toBe(2);
      expect(state.error).toBeNull();
      // The failure is still logged for diagnostics.
      expect(logged[0]?.[0]).toBe('Failed to load transcripts:');
      expect(logged[0]?.[1]).toBeInstanceOf(Error);
    } finally {
      console.error = originalError;
    }
  });

  test('a single delete does not spend a window reload', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2', 't3'], 3, false));

    await act(async () => { void state.deleteTranscripts(['t2']); });
    await resolve(deleteRequest('A'), { message: 'ok' });

    // Hover trash stays the cheap optimistic path: only the initial page read.
    expect(requests.filter(r => r.command === 'api_get_meeting_transcripts')).toHaveLength(1);
  });

  test('a late delete response cannot touch a newly selected meeting', async () => {
    await show('A');
    await resolve(request('metadata', 'A'), metadata('A'));
    await resolve(request('transcripts', 'A'), manyPage(['t1', 't2'], 2, false));

    await act(async () => { void state.deleteTranscripts(['t1']).catch(() => {}); });
    const deleteReq = deleteRequest('A');
    await load('B');
    await act(async () => { deleteReq.reject(new Error('late failure')); });

    expect(state.segments.map(s => s.id)).toEqual(['B']);
    expect(state.totalCount).toBe(1);
  });

  test('the metadata keeps the meeting moment the header renders', async () => {
    // The open meeting's date reaches the page through this hook, so a lost
    // field here would silently drop the header date even though the backend
    // sends it.
    await show('A');
    await resolve(request('metadata', 'A'), {
      ...metadata('A'),
      recorded_at: '2026-11-18T07:32:05+00:00',
    });
    await resolve(request('transcripts', 'A'), page('A'));
    expect(state.metadata?.recorded_at).toBe('2026-11-18T07:32:05+00:00');
  });
});
