import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Selection mode (ticket 02) lives in the same memoized rows as the hover
// pencil/trash, so this suite mirrors transcript-row-delete.test.tsx mocks:
// tooltip and framer-motion primitives become plain containers, and toasts
// are captured. The rows never invoke Tauri: the bulk delete goes through
// the host callback chain (page → pagination hook), so the view only needs
// inert module imports here.

const Container = ({ children }: any) => <div>{children}</div>;
const originalTooltip = { ...(await import('../../src/components/ui/tooltip')) };
mock.module('../../src/components/ui/tooltip', () => ({
  Tooltip: Container,
  TooltipTrigger: Container,
  TooltipContent: Container,
  TooltipProvider: Container,
}));

const motionContainer = (props: any) => <div>{props.children}</div>;
mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => motionContainer }),
  AnimatePresence: Container,
}));

// Headless react-test-renderer gives the virtualizer a zero-size fake scroll
// element, so the real one reports no visible rows. This stub renders every
// item — enough to prove the virtualized branch receives the selection props
// (the bug where only one render branch gets them, exploration gotcha 11).
mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 60, size: 60 })),
    getTotalSize: () => count * 60,
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}));

const originalRecordingState = { ...(await import('../../src/contexts/RecordingStateContext')) };
mock.module('../../src/contexts/RecordingStateContext', () => ({
  ...originalRecordingState,
  useRecordingState: () => ({ isRecording: true, isPaused: false, activeDuration: null }),
}));

const errorNotify = mock((..._args: unknown[]) => {});
mock.module('sonner', () => ({
  toast: {
    success: mock(),
    error: errorNotify,
    info: mock(),
    warning: mock(),
  },
}));

beforeEach(() => {
  errorNotify.mockClear();
});

const { VirtualizedTranscriptView } = await import(
  '../../src/components/VirtualizedTranscriptView'
);
type TranscriptSegmentData = import('../../src/types').TranscriptSegmentData;
type ViewProps = import('../../src/components/VirtualizedTranscriptView').VirtualizedTranscriptViewProps;

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function render(
  segments: TranscriptSegmentData[],
  props: Partial<ViewProps> = {},
) {
  await act(async () => {
    renderer = create(
      <VirtualizedTranscriptView
        segments={segments}
        isRecording={false}
        showConfidence={false}
        {...props}
      />,
      {
        createNodeMock: () => ({
          addEventListener: () => {},
          removeEventListener: () => {},
          scrollTop: 0,
          scrollHeight: 0,
          clientHeight: 0,
          style: {},
          focus: () => {},
          getBoundingClientRect: () => ({
            top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
          }),
          observe: () => {},
          disconnect: () => {},
        }),
      },
    );
  });
  return renderer!;
}

const rows = (...ids: string[]): TranscriptSegmentData[] =>
  ids.map((id, index) => ({ id, timestamp: index, text: `text ${id}` }));

function checkboxes(instance: ReactTestRenderer) {
  return instance.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
}

async function clickCheckbox(instance: ReactTestRenderer, box: { props: any }) {
  await act(async () => { box.props.onChange({ target: { checked: !box.props.checked } }); });
}

function buttonText(node: { props: any }): string {
  const children = node.props.children;
  if (Array.isArray(children)) {
    return children.map(child => (typeof child === 'string' ? child : '')).join('');
  }
  return typeof children === 'string' ? children : '';
}

function buttonByText(instance: ReactTestRenderer, text: string) {
  return instance.root.findAll(
    n => n.type === 'button' && buttonText(n) === text,
  )[0];
}

function buttonContaining(instance: ReactTestRenderer, text: string) {
  return instance.root.findAll(
    n => n.type === 'button' && buttonText(n).includes(text),
  )[0];
}

async function click(instance: ReactTestRenderer, node: { props: any }) {
  await act(async () => { node.props.onClick(); });
}

describe('transcript selection mode on the rows', () => {
  test('selection mode puts a checkbox on every row', async () => {
    const view = await render(rows('t1', 't2'), {
      selectionMode: true,
      selectedIds: ['t1'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    const boxes = checkboxes(view);
    expect(boxes).toHaveLength(2);
    // The selected row's box is checked — the counter and the checkboxes
    // read from the same id set.
    expect(boxes[0].props.checked).toBe(true);
    expect(boxes[1].props.checked).toBe(false);
  });

  test('the checkbox hands its row id to the host selection', async () => {
    const toggle = mock(((_id: string) => {}) as (id: string) => void);
    const view = await render(rows('t1', 't2'), {
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: toggle,
      onSegmentsBulkDeleted: async () => {},
    });

    await clickCheckbox(view, checkboxes(view)[1]);

    expect(toggle.mock.calls).toEqual([['t2']]);
  });

  test('without the mode the rows stay plain (no checkboxes)', async () => {
    const view = await render(rows('t1', 't2'), {
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    expect(checkboxes(view)).toHaveLength(0);
    expect(buttonContaining(view, 'Delete (')).toBeUndefined();
  });

  test('the mode also reaches the virtualized branch (large lists)', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `t${i}`);
    const view = await render(rows(...ids), {
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    // The first viewport of a 12-row virtualized list must carry checkboxes
    // too: both render branches share the row component.
    expect(checkboxes(view)).toHaveLength(12);
  });

  test('the gates close the mode: recording, diarization, retranscription', async () => {
    const shared: Partial<ViewProps> = {
      selectionMode: true,
      selectedIds: ['t1'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    };

    const blockers: Partial<ViewProps>[] = [{ isRecording: true }, { isDiarizing: true }, { isRetranscribing: true }];
    for (const blocker of blockers) {
      const view = await render(rows('t1', 't2'), { ...shared, ...blocker });
      expect(checkboxes(view)).toHaveLength(0);
      expect(buttonByText(view, 'Delete (')).toBeUndefined();
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
  });
});

describe('the selection action bar', () => {
  test('«Delete (N)» counts the selected segments', async () => {
    const view = await render(rows('t1', 't2', 't3'), {
      selectionMode: true,
      selectedIds: ['t1', 't3'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    expect(buttonByText(view, 'Delete (2)')).toBeDefined();
  });

  test('the delete button is inert with nothing selected', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    const view = await render(rows('t1'), {
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: bulk,
    });

    const button = buttonByText(view, 'Delete (0)');
    expect(button).toBeDefined();
    expect(button.props.disabled).toBe(true);
  });

  test('a single selected segment deletes without confirmation', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    const view = await render(rows('t1', 't2'), {
      selectionMode: true,
      selectedIds: ['t1'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: bulk,
    });

    await click(view, buttonByText(view, 'Delete (1)'));

    expect(bulk.mock.calls).toEqual([[['t1']]]);
    // No confirmation stood in the way: no modal, no second press.
    expect(buttonByText(view, 'Delete 1 speech segment?')).toBeUndefined();
  });

  test('deleting several asks «Delete N segments?» first', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    const view = await render(rows('t1', 't2', 't3'), {
      selectionMode: true,
      selectedIds: ['t1', 't2', 't3'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: bulk,
    });

    await click(view, buttonByText(view, 'Delete (3)'));

    // The batch is held until the confirmation answers.
    expect(bulk).not.toHaveBeenCalled();
    const modalText = JSON.stringify(view.toJSON());
    expect(modalText).toContain('Delete 3 speech segments?');

    const confirm = buttonByText(view, 'Delete');
    expect(confirm).toBeDefined();
    await click(view, confirm);
    expect(bulk.mock.calls).toEqual([[['t1', 't2', 't3']]]);
  });

  test('cancelling the confirmation deletes nothing and keeps the selection', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    const view = await render(rows('t1', 't2'), {
      selectionMode: true,
      selectedIds: ['t1', 't2'],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: bulk,
    });

    await click(view, buttonByText(view, 'Delete (2)'));
    const cancel = buttonByText(view, 'Cancel');
    expect(cancel).toBeDefined();
    await click(view, cancel);

    expect(bulk).not.toHaveBeenCalled();
    // The mode stays open with its checkboxes: the user keeps selecting.
    expect(checkboxes(view)).toHaveLength(2);
  });

  test('a failed bulk delete toasts translated strings, never the raw error', async () => {
    const bulk = async (_ids: string[]) => {
      throw new Error(
        'error returned from database: (code: 1) no such table: transcripts in transcript Secret meeting words',
      );
    };
    const consoleErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args); };
    try {
      const view = await render(rows('t1', 't2'), {
        selectionMode: true,
        selectedIds: ['t1', 't2'],
        onToggleSelected: () => {},
        onSegmentsBulkDeleted: bulk,
      });

      await click(view, buttonByText(view, 'Delete (2)'));
      await click(view, buttonByText(view, 'Delete'));
    } finally {
      console.error = originalConsoleError;
    }

    // The batch toasts the bulk wording (plural, no per-segment count in
    // the title); the single row keeps its singular keys.
    expect(errorNotify).toHaveBeenCalled();
    const [title, options] = errorNotify.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe('Failed to delete segments');
    expect(options.description).toBe('The segments are still in the transcript.');
    const toastText = JSON.stringify(errorNotify.mock.calls[0]);
    expect(toastText).not.toContain('no such table');
    expect(toastText).not.toContain('database');
    expect(toastText).not.toContain('Secret meeting words');
    expect(consoleErrors.some(entry => String(entry).includes('no such table'))).toBe(true);
  });
});
