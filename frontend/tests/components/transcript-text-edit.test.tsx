import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Inline text editing lives in the memoized row of VirtualizedTranscriptView.
// The mocks below mirror diarization-speaker-labels.test.tsx: tooltip and
// framer-motion primitives become plain containers, the Tauri invoke is a
// recorder, and toasts are captured.

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

// Row saves go through Tauri; tests record the payload and control failures.
const originalCore = { ...(await import('@tauri-apps/api/core')) };
let saveText: (args?: Record<string, unknown>) => Promise<unknown>;
const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'api_update_transcript_text') return saveText(args);
  throw new Error(`Unexpected command: ${command}`);
});
mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));

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
  // Another suite may have restored the real module while this file ran, so
  // re-apply the fake backend before every test (same defense as the existing
  // transcript row suite).
  mock.module('@tauri-apps/api/core', () => ({ ...originalCore, invoke }));
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { __TAURI_INTERNALS__: { invoke } },
  });
  saveText = async () => ({ message: 'Transcript text saved successfully' });
  invoke.mockClear();
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
  Reflect.deleteProperty(globalThis, 'window');
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
          // The row's editor auto-resize writes style.height off the ref.
          style: {},
          focus: () => {},
          getBoundingClientRect: () => ({
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
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

function textarea(instance: ReactTestRenderer) {
  return instance.root.findAll(n => n.type === 'textarea')[0];
}

async function openEditor(instance: ReactTestRenderer) {
  const button = pencil(instance);
  expect(button).toBeDefined();
  await act(async () => {
    button.props.onClick();
  });
}

async function type(instance: ReactTestRenderer, value: string) {
  await act(async () => {
    textarea(instance).props.onChange({ target: { value } });
  });
}

async function press(
  instance: ReactTestRenderer,
  key: string,
  options: { shiftKey?: boolean } = {},
) {
  const preventDefault = mock(() => {});
  await act(async () => {
    textarea(instance).props.onKeyDown({ key, shiftKey: options.shiftKey ?? false, preventDefault });
  });
  return preventDefault;
}

async function blur(instance: ReactTestRenderer) {
  await act(async () => {
    textarea(instance).props.onBlur();
  });
}

describe('inline transcript text editing', () => {
  test('a meeting row shows the edit pencil', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Hello there' }],
      { onTextEdited: async () => {} },
    );

    expect(pencil(view)).toBeDefined();
    expect(text(view)).toContain('Hello there');
  });

  test('the pencil is absent while recording', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Live text' }],
      { isRecording: true, onTextEdited: async () => {} },
    );

    expect(pencil(view)).toBeUndefined();
  });

  test('the pencil is absent when the host passes no text callback (live panel)', async () => {
    const view = await render([{ id: 't1', timestamp: 0, text: 'No editing here' }]);

    expect(pencil(view)).toBeUndefined();
    expect(text(view)).toContain('No editing here');
  });

  test('the editor opens with the raw text, not the filler-cleaned display', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'uh hello there' }],
      { onTextEdited: async () => {} },
    );

    await openEditor(view);

    // The display shows the cleaned form, the editor must carry the raw text.
    expect(text(view)).toContain('hello there');
    expect(textarea(view).props.value).toBe('uh hello there');
  });

  test('Enter saves the normalized text and closes the editor', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Old words' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, '  Fixed   words\nwith newline  ');
    await press(view, 'Enter');

    expect(invoke.mock.calls).toContainEqual([
      'api_update_transcript_text',
      { transcriptId: 't1', text: 'Fixed words with newline' },
    ]);
    expect(edited.mock.calls).toContainEqual(['t1', 'Fixed words with newline']);
    expect(textarea(view)).toBeUndefined();
  });

  test('losing focus saves the same way Enter does', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Old words' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, 'Blur saved');
    await blur(view);

    expect(invoke.mock.calls).toContainEqual([
      'api_update_transcript_text',
      { transcriptId: 't1', text: 'Blur saved' },
    ]);
    expect(edited.mock.calls).toContainEqual(['t1', 'Blur saved']);
    expect(textarea(view)).toBeUndefined();
  });

  test('Shift+Enter never inserts a newline', async () => {
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'One line' }],
      { onTextEdited: async () => {} },
    );

    await openEditor(view);
    const preventDefault = await press(view, 'Enter', { shiftKey: true });

    expect(preventDefault).toHaveBeenCalled();
    // No save, editor stays open.
    expect(invoke).not.toHaveBeenCalled();
    expect(textarea(view)).toBeDefined();
  });

  test('Escape cancels the edit without any save', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Original text' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, 'Discarded draft');
    await press(view, 'Escape');

    expect(invoke).not.toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
    expect(textarea(view)).toBeUndefined();
    expect(text(view)).toContain('Original text');
  });

  test('saving the unchanged text does not call the backend', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Same as before' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await press(view, 'Enter');

    expect(invoke).not.toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
    expect(textarea(view)).toBeUndefined();
  });

  test('a failed save keeps the row text and toasts an error', async () => {
    saveText = async () => {
      throw new Error('database is locked');
    };
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Original text' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, 'Never stored');
    await press(view, 'Enter');

    expect(edited).not.toHaveBeenCalled();
    expect(errorNotify).toHaveBeenCalled();
    expect(errorNotify.mock.calls[0][0]).toBe('Failed to update text');
    expect(text(view)).toContain('Original text');
  });

  test('a whitespace-only draft is rejected by the backend and toasts an error', async () => {
    // The repository is authoritative on "never empty" (it rejects the save),
    // and the row surfaces that rejection like any other failed save.
    saveText = async () => {
      throw new Error('transcript text cannot be empty');
    };
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Keep me' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, '   \n  ');
    await press(view, 'Enter');

    // The save attempt goes to the backend, which is the authority that
    // rejects it; the row never silently swallows the empty edit.
    expect(invoke.mock.calls).toContainEqual([
      'api_update_transcript_text',
      { transcriptId: 't1', text: '' },
    ]);
    expect(edited).not.toHaveBeenCalled();
    expect(errorNotify).toHaveBeenCalled();
    expect(errorNotify.mock.calls[0][0]).toBe('Failed to update text');
    expect(text(view)).toContain('Keep me');
  });

  test('the error toast names the failure without repeating meeting content', async () => {
    saveText = async () => {
      throw new Error('transcript not found: transcript-42');
    };
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Secret meeting words' }],
      { onTextEdited: async () => {} },
    );

    await openEditor(view);
    await type(view, 'Confidential private correction');
    await press(view, 'Enter');

    expect(errorNotify).toHaveBeenCalled();
    const [title, options] = errorNotify.mock.calls[0];
    // The title is the translated, generic label and the description is the
    // backend's own message — neither carries the old text or the discarded
    // draft (the command's errors only ever mention the row id).
    expect(title).toBe('Failed to update text');
    const toastText = JSON.stringify([title, options]);
    expect(toastText).not.toContain('Secret meeting words');
    expect(toastText).not.toContain('Confidential private correction');
  });

  test('blur after Escape never revives the discarded draft', async () => {
    const edited = mock(async (_id: string, _text: string) => {});
    const view = await render(
      [{ id: 't1', timestamp: 0, text: 'Original text' }],
      { onTextEdited: edited },
    );

    await openEditor(view);
    await type(view, 'Discarded draft');
    // Keep a handle on the blur handler before the editor closes: some
    // browsers fire focusout when the focused element is removed from the DOM,
    // and that late blur must not save what Escape just cancelled.
    const blurAfterEscape = textarea(view).props.onBlur;
    await press(view, 'Escape');
    await act(async () => {
      blurAfterEscape();
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(edited).not.toHaveBeenCalled();
    expect(text(view)).toContain('Original text');
  });
});
