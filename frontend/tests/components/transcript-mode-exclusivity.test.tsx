import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Mode exclusivity over the transcript rows (ticket 04): only one bulk mode
// at a time. The row-level half of the contract lives in the memoized row of
// VirtualizedTranscriptView (the same harness as transcript-text-edit:
// tooltip/framer-motion become containers, toasts are captured, the host
// callbacks record what the view hands them). The page-level half — the
// find panel closing on entering the mode and the mode closing when find
// opens (button and Ctrl+F/H hotkey path) — is covered by the page suite.

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

// The recording status bar reads the recording state context; only the live
// (non-interactive) case renders it, so a static idle state is enough.
const originalRecordingState = { ...(await import('../../src/contexts/RecordingStateContext')) };
mock.module('../../src/contexts/RecordingStateContext', () => ({
  ...originalRecordingState,
  useRecordingState: () => ({ isRecording: true, isPaused: false, activeDuration: null }),
}));

const successNotify = mock((..._args: unknown[]) => {});
const errorNotify = mock((..._args: unknown[]) => {});
const infoNotify = mock((..._args: unknown[]) => {});
const warningNotify = mock((..._args: unknown[]) => {});
mock.module('sonner', () => ({
  toast: {
    success: successNotify,
    error: errorNotify,
    info: infoNotify,
    warning: warningNotify,
  },
}));

beforeEach(() => {
  successNotify.mockClear();
  errorNotify.mockClear();
  infoNotify.mockClear();
  warningNotify.mockClear();
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

/** Re-render the mounted view with new props, preserving every row's state. */
async function rerender(
  instance: ReactTestRenderer,
  segments: TranscriptSegmentData[],
  props: Partial<ViewProps> = {},
) {
  await act(async () => {
    instance.update(
      <VirtualizedTranscriptView
        segments={segments}
        isRecording={false}
        showConfidence={false}
        {...props}
      />,
    );
  });
}

function text(instance: ReactTestRenderer): string {
  return JSON.stringify(instance.toJSON());
}

function pencil(instance: ReactTestRenderer) {
  return instance.root.findAll(
    n => n.type === 'button' && n.props.title === 'Edit text',
  )[0];
}

function textarea(instance: ReactTestRenderer) {
  return instance.root.findAll(n => n.type === 'textarea')[0];
}

function checkboxes(instance: ReactTestRenderer) {
  return instance.root.findAll(n => n.type === 'input' && n.props.type === 'checkbox');
}

async function click(instance: ReactTestRenderer, node: { props: any }) {
  await act(async () => { node.props.onClick(); });
}

async function openEditor(instance: ReactTestRenderer) {
  const button = pencil(instance);
  expect(button).toBeDefined();
  await click(instance, button);
}

async function type(instance: ReactTestRenderer, value: string) {
  await act(async () => {
    textarea(instance).props.onChange({ target: { value } });
  });
}

const rows = (...ids: string[]): TranscriptSegmentData[] =>
  ids.map((id, index) => ({ id, timestamp: index, text: `text ${id}` }));

describe('selection mode over an open inline editor', () => {
  test('entering selection mode over an open editor saves the draft once and closes the editor', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const props: Partial<ViewProps> = { onTextEdited: edited };
    const view = await render(rows('t1'), props);

    await openEditor(view);
    await type(view, '  Draft before selecting  ');

    // The mode turns on over the open editor: the draft goes through the same
    // host save path Enter uses — once — and the editor closes.
    await rerender(view, rows('t1'), {
      ...props,
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    expect(edited.mock.calls).toEqual([['t1', 'Draft before selecting']]);
    expect(textarea(view)).toBeUndefined();
    // The row is now a checkbox row, not an editor row.
    expect(checkboxes(view)).toHaveLength(1);
  });

  test('entering selection mode over an untouched editor just closes it', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const props: Partial<ViewProps> = { onTextEdited: edited };
    const view = await render(rows('t1'), props);

    await openEditor(view);

    await rerender(view, rows('t1'), {
      ...props,
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    // Nothing was typed: closing stores nothing.
    expect(edited).not.toHaveBeenCalled();
    expect(textarea(view)).toBeUndefined();
    expect(checkboxes(view)).toHaveLength(1);
  });
});

describe('the pencil over an active selection mode', () => {
  test('the pencil stays reachable while the mode is on', async () => {
    const view = await render(rows('t1'), {
      onTextEdited: async () => {},
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
    });

    expect(pencil(view)).toBeDefined();
    expect(checkboxes(view)).toHaveLength(1);
  });

  test('clicking the pencil from selection mode asks the host to exit the mode and opens the editor', async () => {
    const exitSelection = mock(() => {});
    const view = await render(rows('t1'), {
      onTextEdited: async () => {},
      selectionMode: true,
      selectedIds: [],
      onToggleSelected: () => {},
      onSegmentsBulkDeleted: async () => {},
      onExitSelection: exitSelection,
    });

    await openEditor(view);

    // The host drops the mode (ids included); the editor opens locally.
    expect(exitSelection).toHaveBeenCalledTimes(1);
    expect(textarea(view)).toBeDefined();
  });

  test('the pencil behaves unchanged without a selection host (live page)', async () => {
    const view = await render(rows('t1'), { onTextEdited: async () => {} });

    await openEditor(view);

    expect(textarea(view)).toBeDefined();
  });
});
