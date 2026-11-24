import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The hover trash lives in the same memoized row as the hover pencil, so this
// suite mirrors the mocks of transcript-text-edit.test.tsx: tooltip and
// framer-motion primitives become plain containers, and toasts are captured.
// The row itself never invokes Tauri: deletion goes through the host callback
// (the pagination hook owns the optimistic state and the rollback), so there
// is no invoke to fake here beyond keeping module imports inert.

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

function text(instance: ReactTestRenderer): string {
  return JSON.stringify(instance.toJSON());
}

/** The hover pencil: the only button on a text row while not editing. */
function pencil(instance: ReactTestRenderer) {
  return instance.root.findAll(
    n => n.type === 'button' && n.props.title === 'Edit text',
  )[0];
}

/** The hover trash: sits next to the pencil. */
function trash(instance: ReactTestRenderer) {
  return instance.root.findAll(
    n => n.type === 'button' && n.props.title === 'Delete speech segment',
  )[0];
}

async function clickTrash(instance: ReactTestRenderer) {
  const button = trash(instance);
  expect(button).toBeDefined();
  await act(async () => {
    button.props.onClick();
  });
}

describe('single speech segment deletion from the row', () => {
  test('a meeting row shows the trash next to the pencil', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Hello there' }],
      { onTextEdited: async () => {}, onSegmentDeleted: async () => {} },
    );

    expect(pencil(view)).toBeDefined();
    expect(trash(view)).toBeDefined();
  });

  test('the trash deletes at once, without any confirmation', async () => {
    const deleted = mock(async (_id: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Throwaway words' }],
      { onSegmentDeleted: deleted },
    );

    await clickTrash(view);

    // The row hands the id to the host save path (the hook owns the
    // optimistic removal and the rollback). No dialog stands in the way.
    expect(deleted.mock.calls).toEqual([['t1']]);
  });

  test('the trash is absent while recording', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Live text' }],
      { isRecording: true, onSegmentDeleted: async () => {} },
    );

    expect(trash(view)).toBeUndefined();
  });

  test('the trash is absent while a diarization pass runs', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Diarized soon' }],
      { isDiarizing: true, onSegmentDeleted: async () => {} },
    );

    expect(trash(view)).toBeUndefined();
  });

  test('the trash is absent while the meeting is being retranscribed', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Retranscribing soon' }],
      { isRetranscribing: true, onSegmentDeleted: async () => {} },
    );

    expect(trash(view)).toBeUndefined();
  });

  test('the trash is absent when the host passes no delete callback (live panel)', async () => {
    const view = await render([{ id: 't1', timestamp: 0, text: 'No deleting here' }]);

    expect(trash(view)).toBeUndefined();
    expect(text(view)).toContain('No deleting here');
  });

  test('a failed delete toasts translated strings, never the raw error', async () => {
    const deleted = async (_id: string) => {
      throw new Error(
        'error returned from database: (code: 19) FOREIGN KEY constraint failed in transcript Secret meeting words',
      );
    };
    const consoleErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args); };
    try {
      const view = await render(
        [{ id: 't1', timestamp: 0, text: 'Secret meeting words' }],
        { onSegmentDeleted: deleted },
      );
      await clickTrash(view);
    } finally {
      console.error = originalConsoleError;
    }

    expect(errorNotify).toHaveBeenCalled();
    const [title, options] = errorNotify.mock.calls[0] as [string, Record<string, unknown>];
    expect(title).toBe('Failed to delete segment');
    expect(options.description).toBe('The segment is still in the transcript.');
    const toastText = JSON.stringify(errorNotify.mock.calls[0]);
    expect(toastText).not.toContain('FOREIGN KEY');
    expect(toastText).not.toContain('database');
    expect(toastText).not.toContain('Secret meeting words');
    // Diagnostics keep the raw error for the logs.
    expect(consoleErrors.some(entry => String(entry).includes('FOREIGN KEY'))).toBe(true);
  });
});
