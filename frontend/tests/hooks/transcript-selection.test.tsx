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

  // Ticket 03: the bulk-selection assistants — «select all visible»,
  // by-speaker (a plain replace of the id set through setSelectedIds),
  // and the file-manager Shift-click range.
  test('select all visible marks every loaded segment at once', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });

    await act(async () => { state.selectAllVisible(['t1', 't2', 't3']); });

    // Re-selecting an already-selected row keeps its selection-order slot:
    // the Shift anchor is the LAST id the user really touched, not the list
    // order, so re-adding an existing id must not bump it to the end.
    expect(state.selectedIds).toEqual(['t1', 't2', 't3']);
    expect(state.selectedCount).toBe(3);
  });

  test('select all visible over an empty load clears the selection', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });

    await act(async () => { state.selectAllVisible([]); });

    // No visible rows means nothing to select — a stale id must never
    // survive a press over an empty list.
    expect(state.selectedIds).toEqual([]);
  });

  test('a second select-all-visible press clears the selection', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });

    await act(async () => { state.toggleAllVisible(['t1', 't2']); });
    expect(state.selectedIds).toEqual(['t1', 't2']);

    await act(async () => { state.toggleAllVisible(['t1', 't2']); });
    expect(state.selectedIds).toEqual([]);
  });

  test('select-all-visible re-press over a partial selection selects the rest', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t1'); });

    // Not everything is marked yet, so the press completes the selection
    // instead of clearing it — the clear only answers «everything visible».
    await act(async () => { state.toggleAllVisible(['t1', 't2', 't3']); });
    expect(state.selectedIds).toEqual(['t1', 't2', 't3']);
  });

  test('shift-click ranges from the last selected row across the loaded order', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t2'); });

    // The file manager's rule: the range runs from the last selected row
    // (t2) to the clicked one (t5) in the list's own order — inclusive,
    // and an earlier anchor works the same backwards.
    await act(async () => { state.rangeSelectTo('t5', ['t1', 't2', 't3', 't4', 't5']); });
    expect(state.selectedIds).toEqual(['t2', 't3', 't4', 't5']);

    await act(async () => { state.exitSelection(); });
    await act(async () => { state.enterSelection(); });
    await act(async () => { state.toggleSelected('t5'); });
    await act(async () => { state.rangeSelectTo('t3', ['t1', 't2', 't3', 't4', 't5']); });
    expect(state.selectedIds).toEqual(['t5', 't4', 't3']);
  });

  test('shift-click without an anchor selects just the clicked row', async () => {
    await show('A');
    await act(async () => { state.enterSelection(); });

    // Nothing was selected before, so there is no range to extend: the
    // Shift-click behaves like a single selection.
    await act(async () => { state.rangeSelectTo('t3', ['t1', 't2', 't3']); });
    expect(state.selectedIds).toEqual(['t3']);
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
