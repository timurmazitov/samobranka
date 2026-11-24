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
