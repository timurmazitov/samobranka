import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The summary editor's save de-dup (meeting-view-toggle review): the blur
// autosave and the tab-switch guard can both call the ref API's saveSummary
// for the same click — the dirty flag flips only after the save resolves, so
// without an in-flight guard the second call starts a twin save. The real
// BlockNoteSummaryView is rendered with the BlockNote machinery stubbed at
// the module seams (the child Editor, the editor factory, the view) so the
// tests drive edits through the child's onChange exactly like the mounted
// editor would and observe the ref API's contract: concurrent callers share
// one save, and edits made during a save stay dirty for the next caller.

const originalDynamic = { ...await import('next/dynamic') };
const originalBlockNoteReact = { ...await import('@blocknote/react') };
const originalBlockNoteShadcn = { ...await import('@blocknote/shadcn') };

// The child Editor (a next/dynamic import in the view) captures its props so
// the tests can fire onChange like the real BlockNote editor does.
let editorProps: Record<string, any>;
mock.module('next/dynamic', () => ({
  default: () => (props: any) => {
    editorProps = props;
    return <div data-editor="true" />;
  },
}));

// useCreateBlockNote builds a real tiptap editor, which needs a DOM; the
// fake covers exactly what the view's save path touches.
const fakeEditor = {
  document: [],
  transact: (fn: any) => fn(),
  tryParseMarkdownToBlocks: async () => [],
  replaceBlocks: () => {},
  blocksToMarkdownLossy: async () => 'markdown',
};
mock.module('@blocknote/react', () => ({
  useCreateBlockNote: () => fakeEditor,
}));
mock.module('@blocknote/shadcn', () => ({
  BlockNoteView: () => <div />,
}));
mock.module('@blocknote/shadcn/style.css', () => ({}));

afterAll(() => {
  mock.module('next/dynamic', () => originalDynamic);
  mock.module('@blocknote/react', () => originalBlockNoteReact);
  mock.module('@blocknote/shadcn', () => originalBlockNoteShadcn);
});

await import('../../src/i18n');
// The query suffix bypasses bun's cross-file mock registry: the component
// suites in this process stub the BlockNoteSummaryView module (the
// documented mock-pollution convention), and this suite needs the real one.
// @ts-expect-error bun resolves the query-suffixed specifier; tsc does not.
const { BlockNoteSummaryView } = await import('../../src/components/AISummary/BlockNoteSummaryView?real') as typeof import('../../src/components/AISummary/BlockNoteSummaryView');
const React = await import('react');

const BLOCK = { id: 'b1', type: 'paragraph', content: [] };
const SUMMARY_DATA = { summary_json: [BLOCK] } as any;

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  editorProps = undefined as any;
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function show(onSave: (data: unknown) => Promise<void>) {
  const ref = React.createRef<any>();
  await act(async () => {
    renderer = create(
      <BlockNoteSummaryView ref={ref} summaryData={SUMMARY_DATA} onSave={onSave} />,
    );
  });
  // The view marks its content loaded on a 100ms timer; only edits after
  // that raise the dirty flag.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  return ref;
}

/** Fire the child editor's onChange like a user edit. */
async function edit() {
  await act(async () => { editorProps.onChange([BLOCK]); });
}

describe('summary editor save de-dup', () => {
  test('concurrent saveSummary calls share one in-flight save', async () => {
    let resolveSave!: () => void;
    const onSave = mock(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    const ref = await show(onSave);
    await edit();
    expect(ref.current.isDirty).toBe(true);

    // The blur autosave and the tab-switch guard firing for the same click.
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = ref.current.saveSummary();
      second = ref.current.saveSummary();
    });

    // One save for both callers, and the tab switch's await settles with it.
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave(); await Promise.all([first, second]); });
    expect(ref.current.isDirty).toBe(false);
  });

  test('an edit made during the in-flight save stays dirty for the next caller', async () => {
    let resolveSave!: () => void;
    const onSave = mock(() => {
      // Only the first save is held in flight; later saves resolve at once.
      if (onSave.mock.calls.length > 1) return Promise.resolve();
      return new Promise<void>((resolve) => { resolveSave = resolve; });
    });
    const ref = await show(onSave);
    await edit();

    let first!: Promise<void>;
    await act(async () => { first = ref.current.saveSummary(); });
    expect(onSave).toHaveBeenCalledTimes(1);

    // The user keeps typing while the save is in flight.
    await edit();
    await act(async () => { resolveSave(); await first; });

    // The new edits were not part of the finished save: still dirty, and the
    // next caller saves them.
    expect(ref.current.isDirty).toBe(true);
    await act(async () => { await ref.current.saveSummary(); });
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(ref.current.isDirty).toBe(false);
  });
});
