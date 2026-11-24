import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Ticket 03's selection assistants live in the mode's action bar (the same
// sticky row as «Удалить (N)»): «Выделить всё видимое», the by-speaker
// dropdown, and Shift-click on a row. The harness mirrors
// transcript-selection-mode.test.tsx: tooltip/framer-motion/dropdown become
// plain containers, the virtualizer stub renders every row, and toasts stay
// inert. The real logic is the page's (useTranscriptSelection + the keydown
// listener); the view only forwards intent through host callbacks.
//
// Like swept-components-i18n.test.tsx, the shared module fakes are registered
// in beforeEach (bun installs every file's module-scope mocks before running
// any test, so a top-level registration leaks into other suites) and restored
// in afterAll.

const Container = ({ children }: any) => <div>{children}</div>;
const motionContainer = (props: any) => <div>{props.children}</div>;
const DropdownContainer = ({ children }: any) => <div>{children}</div>;
const DropdownItem = ({ children, onSelect, onClick }: any) => (
  <li onSelect={onSelect} onClick={onClick}>{children}</li>
);

const originalTooltip = { ...(await import('../../src/components/ui/tooltip')) };
const originalMotion = { ...(await import('framer-motion')) };
const originalDropdown = { ...(await import('../../src/components/ui/dropdown-menu')) };
const originalRecordingState = { ...(await import('../../src/contexts/RecordingStateContext')) };

function applyMocks() {
  mock.module('../../src/components/ui/tooltip', () => ({
    Tooltip: Container,
    TooltipTrigger: Container,
    TooltipContent: Container,
    TooltipProvider: Container,
  }));
  mock.module('framer-motion', () => ({
    motion: new Proxy({}, { get: () => motionContainer }),
    AnimatePresence: Container,
  }));
  // The by-speaker control is a Radix dropdown — a portal that needs a DOM.
  // Menu items become plain elements whose onClick fires the real onSelect,
  // the same stand-in diarization-speaker-labels.test.tsx uses for the chip.
  mock.module('../../src/components/ui/dropdown-menu', () => ({
    DropdownMenu: DropdownContainer,
    DropdownMenuTrigger: DropdownContainer,
    DropdownMenuContent: DropdownContainer,
    DropdownMenuItem: DropdownItem,
    DropdownMenuLabel: DropdownContainer,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuGroup: DropdownContainer,
    DropdownMenuCheckboxItem: DropdownItem,
    DropdownMenuRadioItem: DropdownItem,
    DropdownMenuRadioGroup: DropdownContainer,
  }));
  mock.module('../../src/contexts/RecordingStateContext', () => ({
    ...originalRecordingState,
    useRecordingState: () => ({ isRecording: true, isPaused: false, activeDuration: null }),
  }));
  // Headless react-test-renderer gives the virtualizer a zero-size fake
  // scroll element, so the real one reports no visible rows. This stub
  // renders every item (same as transcript-selection-mode.test.tsx).
  mock.module('@tanstack/react-virtual', () => ({
    useVirtualizer: ({ count }: { count: number }) => ({
      getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 60, size: 60 })),
      getTotalSize: () => count * 60,
      measureElement: () => {},
      scrollToIndex: () => {},
    }),
  }));
}

const errorNotify = mock((..._args: unknown[]) => {});
applyMocks();
beforeEach(() => {
  // bun shares module mocks across files in one run: keep this suite's
  // fakes authoritative even when another suite restored a real module.
  // sonner re-registers here too: a module-scope sonner registration leaks
  // into the other component suites' module bodies in the full run.
  applyMocks();
  mock.module('sonner', () => ({
    toast: {
      success: mock(),
      error: errorNotify,
      info: mock(),
      warning: mock(),
    },
  }));
  errorNotify.mockClear();
});
afterAll(() => {
  mock.module('../../src/components/ui/tooltip', () => originalTooltip);
  mock.module('../../src/components/ui/dropdown-menu', () => originalDropdown);
  mock.module('../../src/contexts/RecordingStateContext', () => originalRecordingState);
  // framer-motion and sonner are NOT restored: bun installs every file's
  // mocks before running any test, so restoring them mid-process replaces
  // the real module in suites that registered theirs already (the documented
  // convention in diarization-speaker-labels.test.tsx).
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

function buttonText(node: { props: any }): string {
  const children = node.props.children;
  if (Array.isArray(children)) {
    return children.map(child => (typeof child === 'string' ? child : '')).join('');
  }
  if (typeof children === 'string') return children;
  // A nested element (the dropdown item's <span>): read its own children.
  if (children && typeof children === 'object' && children.props) {
    return buttonText(children);
  }
  return '';
}

function buttonByText(instance: ReactTestRenderer, text: string) {
  return instance.root.findAll(
    n => n.type === 'button' && buttonText(n) === text,
  )[0];
}

function buttonByTitle(instance: ReactTestRenderer, title: string) {
  return instance.root.findAll(
    n => n.type === 'button' && n.props.title === title,
  )[0];
}

async function click(instance: ReactTestRenderer, node: { props: any }) {
  await act(async () => { node.props.onClick(); });
}

function checkboxes(instance: ReactTestRenderer) {
  return instance.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
}

const speakers = [
  { label: 'speaker_0', speaker_name: 'Ann', segment_count: 99, first_start_time: 0 },
  { label: 'speaker_1', speaker_name: null, segment_count: 0, first_start_time: null },
];

const selectionProps: Partial<ViewProps> = {
  selectionMode: true,
  selectedIds: [],
  onToggleSelected: () => {},
  onSegmentsBulkDeleted: async () => {},
};

describe('the «select all visible» assistant', () => {
  test('the bar offers «Select all visible» while the mode is open', async () => {
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      onSelectAllVisible: () => {},
    });
    expect(buttonByText(view, 'Select all visible')).toBeDefined();
  });

  test('the button asks the host to mark every loaded row', async () => {
    const selectAll = mock(() => {});
    const view = await render(rows('t1', 't2', 't3'), {
      ...selectionProps,
      onSelectAllVisible: selectAll,
    });

    await click(view, buttonByText(view, 'Select all visible'));

    expect(selectAll).toHaveBeenCalledTimes(1);
  });

  test('the button disappears with the mode and the gates', async () => {
    const plain = await render(rows('t1', 't2'), { onSelectAllVisible: () => {} });
    expect(buttonByText(plain, 'Select all visible')).toBeUndefined();

    for (const blocker of [{ isRecording: true }, { isDiarizing: true }, { isRetranscribing: true }]) {
      const view = await render(rows('t1', 't2'), {
        ...selectionProps,
        onSelectAllVisible: () => {},
        ...blocker,
      });
      expect(buttonByText(view, 'Select all visible')).toBeUndefined();
      await act(async () => renderer!.unmount());
      renderer = undefined;
    }
  });

  test('a host without the assistant (live page) renders no button', async () => {
    const view = await render(rows('t1', 't2'), { ...selectionProps, onSelectAllVisible: undefined });
    expect(buttonByText(view, 'Select all visible')).toBeUndefined();
  });
});

describe('the by-speaker selection assistant', () => {
  test('the bar lists the meeting speakers', async () => {
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      meetingSpeakers: speakers,
      onSelectBySpeaker: () => {},
    });

    const items = view.root.findAll(n => n.type === 'li');
    const labels = items.map(node => buttonText(node));
    expect(labels).toContain('Ann');
    expect(labels).toContain('Speaker 2');
  });

  test('picking a speaker hands its label to the host', async () => {
    const bySpeaker = mock(((_label: string) => {}) as (label: string) => void);
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      meetingSpeakers: speakers,
      onSelectBySpeaker: bySpeaker,
    });

    const ann = view.root.findAll(n => n.type === 'li' && buttonText(n) === 'Ann')[0];
    expect(ann).toBeDefined();
    await act(async () => { ann.props.onSelect(); });

    expect(bySpeaker.mock.calls).toEqual([['speaker_0']]);
  });

  test('without a speaker host there is no dropdown, and no empty dropdown without speakers', async () => {
    const bare = await render(rows('t1', 't2'), selectionProps);
    expect(buttonByTitle(bare, 'Select all loaded segments of a speaker')).toBeUndefined();

    const noSpeakers = await render(rows('t1', 't2'), {
      ...selectionProps,
      onSelectBySpeaker: () => {},
    });
    expect(buttonByTitle(noSpeakers, 'Select all loaded segments of a speaker')).toBeUndefined();
  });
});

describe('ctrl/shift-click on rows (file-manager selection)', () => {
  function rowTextContainer(instance: ReactTestRenderer, text: string) {
    return instance.root.findAll(
      n => n.type === 'p' && buttonText(n) === text,
    )[0];
  }

  test('a plain click reaches neither handler (text stays selectable)', async () => {
    const range = mock(((_id: string, _mods: { shift: boolean }) => {}) as
      (id: string, mods: { shift: boolean }) => void);
    const toggle = mock(((_id: string) => {}) as (id: string) => void);
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      onToggleSelected: toggle,
      onRowRangeSelect: range,
    });

    const paragraph = rowTextContainer(view, 'text t2');
    await act(async () => {
      paragraph.props.onClick({ shiftKey: false, ctrlKey: false, metaKey: false });
    });

    expect(range).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
  });

  test('a ctrl-click toggles the row like the checkbox does', async () => {
    const range = mock(((_id: string, _mods: { shift: boolean }) => {}) as
      (id: string, mods: { shift: boolean }) => void);
    const toggle = mock(((_id: string) => {}) as (id: string) => void);
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      onToggleSelected: toggle,
      onRowRangeSelect: range,
    });

    const paragraph = rowTextContainer(view, 'text t2');
    await act(async () => {
      paragraph.props.onClick({ shiftKey: false, ctrlKey: true, metaKey: false });
    });

    expect(toggle.mock.calls).toEqual([['t2']]);
    expect(range).not.toHaveBeenCalled();
  });

  test('a shift-click hands the row to the host range handler', async () => {
    const range = mock(((_id: string, _mods: { shift: boolean }) => {}) as
      (id: string, mods: { shift: boolean }) => void);
    const toggle = mock(((_id: string) => {}) as (id: string) => void);
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      onToggleSelected: toggle,
      onRowRangeSelect: range,
    });

    const paragraph = rowTextContainer(view, 'text t2');
    await act(async () => {
      paragraph.props.onClick({ shiftKey: true, ctrlKey: false, metaKey: false });
    });

    expect(range.mock.calls).toEqual([['t2', { shift: true }]]);
    expect(toggle).not.toHaveBeenCalled();
  });

  test('the row click handler is off outside the mode and its gates', async () => {
    const noMode = await render(rows('t1'), { onRowRangeSelect: () => {} });
    expect(rowTextContainer(noMode, 'text t1').props.onClick).toBeUndefined();

    const gated = await render(rows('t1'), {
      ...selectionProps,
      isDiarizing: true,
      onRowRangeSelect: () => {},
    });
    expect(rowTextContainer(gated, 'text t1').props.onClick).toBeUndefined();
  });
});

describe('the Delete-key request (page nonce seam)', () => {
  async function update(segments: TranscriptSegmentData[], props: Partial<ViewProps>) {
    await act(async () => {
      renderer!.update(
        <VirtualizedTranscriptView
          segments={segments}
          isRecording={false}
          showConfidence={false}
          {...props}
        />,
      );
    });
  }

  test('a delete request presses the button: one id deletes at once', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    const view = await render(rows('t1', 't2'), {
      ...selectionProps,
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 0,
    });

    await update(rows('t1', 't2'), {
      ...selectionProps,
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 1,
    });

    expect(bulk.mock.calls).toEqual([[['t1']]]);
  });

  test('a delete request at N>1 opens the same confirmation as the button', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    await render(rows('t1', 't2'), {
      ...selectionProps,
      selectedIds: ['t1', 't2'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 0,
    });

    await update(rows('t1', 't2'), {
      ...selectionProps,
      selectedIds: ['t1', 't2'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 4,
    });

    // The shared confirmation path: nothing deleted until Delete answers.
    expect(bulk).not.toHaveBeenCalled();
    const view = renderer!;
    expect(JSON.stringify(view.toJSON())).toContain('Delete 2 speech segments?');
    await click(view, buttonByText(view, 'Delete'));
    expect(bulk.mock.calls).toEqual([[['t1', 't2']]]);
  });

  test('the same nonce never re-fires', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    await render(rows('t1'), {
      ...selectionProps,
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 7,
    });

    // An unrelated re-render at the same nonce must not delete again — the
    // listener fires once per keypress, the nonce is the whole request.
    await update(rows('t1'), {
      ...selectionProps,
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 7,
    });

    expect(bulk).not.toHaveBeenCalled();
  });

  test('a request outside the mode or its gates deletes nothing', async () => {
    const bulk = mock(async (_ids: string[]) => {});
    await render(rows('t1'), {
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 0,
    });

    await update(rows('t1'), {
      // Mode off, gates closed — the request must be inert.
      isRetranscribing: true,
      selectedIds: ['t1'],
      onSegmentsBulkDeleted: bulk,
      bulkDeleteNonce: 2,
    });

    expect(bulk).not.toHaveBeenCalled();
  });
});
