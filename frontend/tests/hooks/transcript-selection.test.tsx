import { afterEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// No Tauri mock: the selection state has no native calls at all. The meeting
// id arrives as a render argument (like the page's own flow), so meeting
// isolation is observable by updating the View.

const { useTranscriptSelection } = await import(
  '../../src/hooks/meeting-details/useTranscriptSelection'
);

let state: ReturnType<typeof useTranscriptSelection>;
let renderer: ReactTestRenderer | undefined;

function View({ meetingId }: { meetingId: string | null }) {
  state = useTranscriptSelection(meetingId);
  return <output>{String(state.isSelecting)}:{state.selectedIds.join(',')}</output>;
}

async function show(meetingId: string | null) {
  await act(async () => {
    if (renderer) renderer.update(<View meetingId={meetingId} />);
    else renderer = create(<View meetingId={meetingId} />);
  });
}

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

describe('ephemeral transcript segment selection', () => {
  test('the selection mode starts closed with nothing selected', async () => {
    await show('A');
    expect(state.isSelecting).toBe(false);
    expect(state.selectedIds).toEqual([]);
    expect(state.selectedCount).toBe(0);
  });

  test('the button toggles the mode on and off', async () => {
    await show('A');
    await act(async () => { state.toggleSelection(); });
    expect(state.isSelecting).toBe(true);
    await act(async () => { state.toggleSelection(); });
    expect(state.isSelecting).toBe(false);
  });

  test('toggling rows builds the selection and the counter', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });
    await act(async () => { state.toggleSelected('t2'); });
    expect(state.selectedIds).toEqual(['t1', 't2']);
    expect(state.isSelected('t1')).toBe(true);
    expect(state.selectedCount).toBe(2);

    await act(async () => { state.toggleSelected('t1'); });
    expect(state.selectedIds).toEqual(['t2']);
    expect(state.isSelected('t1')).toBe(false);
  });

  test('exiting the mode clears the selection', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });
    await act(async () => { state.exitSelection(); });

    expect(state.isSelecting).toBe(false);
    expect(state.selectedIds).toEqual([]);
  });

  test('entering the mode starts from an empty selection', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });
    await act(async () => { state.exitSelection(); });
    await act(async () => { state.enterSelection(); });

    expect(state.isSelecting).toBe(true);
    expect(state.selectedIds).toEqual([]);
  });

  test('a meeting switch clears both the mode and the selection', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });
    expect(state.selectedIds).toEqual(['t1']);

    await show('B');

    // The selection never crosses meetings: deleting from a stale set would
    // hit rows of the wrong meeting.
    expect(state.isSelecting).toBe(false);
    expect(state.selectedIds).toEqual([]);

    await show('A');
    expect(state.isSelecting).toBe(false);
    expect(state.selectedIds).toEqual([]);
  });
});
