import { afterAll, describe, expect, test } from 'bun:test';

// @blocknote/core injects its CSS at module load and instantiating an editor
// needs a DOM: install a minimal stub for the load and every editor creation
// below (the same documented mock-pollution hazard the decorations suite
// works around). Restored in afterAll so the shared bun process stays clean.
const originalDocument = Reflect.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Reflect.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Reflect.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalGetSelection = Reflect.getOwnPropertyDescriptor(globalThis, 'getSelection');

function stubElement(): any {
  return {
    style: {},
    appendChild: () => {},
    removeChild: () => {},
    insertBefore: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    childNodes: [],
    children: [],
    nodeType: 1,
    tagName: 'DIV',
    focus: () => {},
  };
}

function installDomStub() {
  const documentStub: any = {
    documentElement: { style: {} },
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, removeChild: () => {}, contains: () => false },
    getElementsByTagName: (name: string) => (name === 'head' ? [{ appendChild: () => {} }] : []),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => stubElement(),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
    createRange: () => ({
      setStart: () => {},
      setEnd: () => {},
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      getClientRects: () => [],
      commonAncestorContainer: null,
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  documentStub.defaultView = {
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimeout: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    document: documentStub,
    navigator: { userAgent: 'test' },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentStub });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: documentStub.defaultView });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: documentStub.defaultView.navigator });
  Object.defineProperty(globalThis, 'getSelection', { configurable: true, value: () => null });
}

function restoreDomStub() {
  for (const [key, descriptor] of [
    ['document', originalDocument],
    ['window', originalWindow],
    ['navigator', originalNavigator],
    ['getSelection', originalGetSelection],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}

installDomStub();
const { BlockNoteEditor } = await import('@blocknote/core');restoreDomStub();
afterAll(restoreDomStub);

const reveal = await import('../../src/lib/summary-find-reveal');
const { buildBlockNoteSummaryBlocks } = await import('../../src/lib/summary-find-blocks');
type PMBlockEntry = import('../../src/lib/summary-find-reveal').PMBlockEntry;

/**
 * The position mapping against the REAL BlockNote 0.36 ProseMirror model.
 * The plain-object fixtures in summary-find-reveal.test.ts draw blocks whose
 * text hangs directly off the id-carrying node; BlockNote's actual model
 * wraps it: doc → blockGroup → blockContainer(attrs.id) →
 * paragraph/heading/bulletListItem (block nodes WITHOUT an id) → text runs,
 * and a block's children are a sibling blockGroup of those runs inside the
 * same container. A run is the block's own text unless it lives under a
 * descendant that carries its own id (another BlockNote block); id-less PM
 * block wrappers are transparent. This is exactly where ticket 04's mapping
 * silently returned null — every failure mode here was observed on the real
 * editor before it was written as an expectation.
 */

/** Top-level entries the way `applyFindHighlights` collects them. */
function entriesOf(editor: ReturnType<typeof editorWith>): PMBlockEntry[] {
  const entries: PMBlockEntry[] = [];
  (editor as any).prosemirrorState.doc.forEach((node: any, pos: number) =>
    entries.push(reveal.toPMBlockEntry(node, pos)),
  );
  return entries;
}

function editorWith(content: unknown[]) {
  installDomStub();
  try {
    return BlockNoteEditor.create({ initialContent: content as never });
  } finally {
    restoreDomStub();
  }
}
type BNEditor = ReturnType<typeof editorWith>;

const text = (t: string, styles: Record<string, boolean> = {}) => ({ type: 'text', text: t, styles });

describe('mapBlockTextRangeToPositions on the real BlockNote model', () => {
  test('maps inside a paragraph whose text sits in the id-less blockContent wrapper', () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('Hello '), text('world', { bold: true })] },
    ]);
    const blockId = editor.document[0].id;
    const entries = entriesOf(editor);

    // «world» at block offsets 6..11; the PM doc's own slice is the oracle.
    const mapped = reveal.mapBlockTextRangeToPositions(entries, blockId, 6, 11);
    expect(mapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe('world');
    // A range inside the first run too: block offsets 0..6 are «Hello ».
    const hello = reveal.mapBlockTextRangeToPositions(entries, blockId, 0, 6);
    expect(hello).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(hello!.from, hello!.to)).toBe('Hello ');
  });

  test('maps inside headings and list items (block types beyond paragraph)', () => {
    const editor = editorWith([
      { type: 'heading', props: { level: 2 }, content: [text('alpha heading')] },
      { type: 'bulletListItem', content: [text('beta item')] },
    ]);
    const [heading, item] = editor.document;
    const entries = entriesOf(editor);

    const mappedHeading = reveal.mapBlockTextRangeToPositions(entries, heading.id, 0, 13);
    expect(mappedHeading).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(mappedHeading!.from, mappedHeading!.to)).toBe('alpha heading');

    const mappedItem = reveal.mapBlockTextRangeToPositions(entries, item.id, 5, 9);
    expect(mappedItem).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(mappedItem!.from, mappedItem!.to)).toBe('item');
  });

  test('a nested list item maps its own text, and the parent never counts it', () => {
    const editor = editorWith([
      {
        type: 'bulletListItem',
        content: [text('parent text')],
        children: [{ type: 'bulletListItem', content: [text('nested text')] }],
      },
    ]);
    const parent = editor.document[0];
    const nested = (parent.children as any[])[0];
    const entries = entriesOf(editor);

    // The parent's searchable text is «parent text» only: the nested item's
    // characters never shift its offsets, and offsets past its own text map
    // to nothing rather than reaching into the child.
    expect(buildBlockNoteSummaryBlocks(editor.document)).toEqual([
      { blockId: parent.id, text: 'parent text' },
      { blockId: nested.id, text: 'nested text' },
    ]);
    const parentMapped = reveal.mapBlockTextRangeToPositions(entries, parent.id, 7, 11);
    expect(parentMapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(parentMapped!.from, parentMapped!.to)).toBe('text');
    expect(reveal.mapBlockTextRangeToPositions(entries, parent.id, 11, 16)).toBeNull();

    // The nested block maps its own text by its own id.
    const nestedMapped = reveal.mapBlockTextRangeToPositions(entries, nested.id, 7, 11);
    expect(nestedMapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(nestedMapped!.from, nestedMapped!.to)).toBe('text');
  });

  test('link text is the block’s own — the link mark rides the text node', () => {
    const editor = editorWith([
      {
        type: 'paragraph',
        content: [
          text('see '),
          { type: 'link', href: 'https://example.com', content: [text('alpha link')] },
        ],
      },
    ]);
    const blockId = editor.document[0].id;
    const entries = entriesOf(editor);

    // The composed block text is «see alpha link» (buildBlockNoteSummaryBlocks),
    // so 4..9 is «alpha».
    const mapped = reveal.mapBlockTextRangeToPositions(entries, blockId, 4, 9);
    expect(mapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(mapped!.from, mapped!.to)).toBe('alpha');
  });

  test('a missing block id or a range past the block text maps to nothing', () => {
    const editor = editorWith([{ type: 'paragraph', content: [text('four')] }]);
    const blockId = editor.document[0].id;
    const entries = entriesOf(editor);

    expect(reveal.mapBlockTextRangeToPositions(entries, 'no-such-block', 0, 4)).toBeNull();
    expect(reveal.mapBlockTextRangeToPositions(entries, blockId, 2, 9)).toBeNull();
    expect(reveal.mapBlockTextRangeToPositions(entries, blockId, 3, 2)).toBeNull();
    expect(reveal.mapBlockTextRangeToPositions(entries, blockId, -1, 2)).toBeNull();
  });

  test('two blocks: each id maps only inside its own runs', () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('alpha first')] },
      { type: 'paragraph', content: [text('beta alpha second')] },
    ]);
    const [first, second] = editor.document;
    const entries = entriesOf(editor);

    const firstMapped = reveal.mapBlockTextRangeToPositions(entries, first.id, 6, 11);
    expect(firstMapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(firstMapped!.from, firstMapped!.to)).toBe('first');

    const secondMapped = reveal.mapBlockTextRangeToPositions(entries, second.id, 5, 10);
    expect(secondMapped).not.toBeNull();
    expect((editor as any).prosemirrorState.doc.textBetween(secondMapped!.from, secondMapped!.to)).toBe('alpha');
  });
});
