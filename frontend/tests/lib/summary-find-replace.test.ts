import { afterAll, describe, expect, test } from 'bun:test';

// The replacement runs against the REAL BlockNote 0.36 model, so the DOM stub
// (CSS injection at load + editor creation) is installed for those moments
// and restored around them — the documented mock-pollution discipline of the
// other find & replace suites.
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
const { BlockNoteEditor } = await import('@blocknote/core');
restoreDomStub();
afterAll(restoreDomStub);

const { applySummaryReplacements } = await import('../../src/lib/summary-find-replace');
const { buildBlockNoteSummaryBlocks } = await import('../../src/hooks/meeting-details/useFindReplace');
const reveal = await import('../../src/lib/summary-find-reveal');
type SummaryReplaceEdit = import('../../src/lib/summary-find-replace').SummaryReplaceEdit;

/**
 * Summary replacement on a real ProseMirror/BlockNote document. The contract
 * (ticket 05): edits change only the text inside the matched range — block
 * type, list nesting, marks and links survive — every edit of one call lands
 * in ONE transaction (one undo step, one dirty change), an edit whose range
 * no longer says what the panel saw (`expected`) aborts the whole call
 * without touching the document (a user edit landed in between), and the
 * user's other unsaved content stays exactly as it was.
 */

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

/** The block's composed text plus the per-run styles, the replacement oracle. */
function shapeOf(editor: BNEditor, blockId: string) {
  const blocks = buildBlockNoteSummaryBlocks(editor.document);
  const composed = blocks.find(block => block.blockId === blockId)?.text;
  // Runs are read off the PM doc: text plus the mark names each carries.
  const runs: Array<{ text: string; marks: string[] }> = [];
  const walk = (node: any) => {
    if (node.isText) {
      runs.push({ text: node.text ?? '', marks: (node.marks ?? []).map((m: any) => m.type.name) });
      return;
    }
    if (node.attrs?.id && node.attrs.id !== blockId) return; // nested block: not ours
    node.forEach(walk);
  };
  (editor as any).prosemirrorState.doc.forEach(walk);
  return { composed, runs };
}

describe('applySummaryReplacements on the real BlockNote model', () => {
  test('a replacement inside one styled run keeps every mark and block type', () => {
    const editor = editorWith([
      { type: 'heading', props: { level: 2 }, content: [text('alpha summary', { bold: true })] },
    ]);
    const blockId = editor.document[0].id;

    const applied = applySummaryReplacements(editor, [
      { blockId, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
    ]);
    expect(applied).toBe(true);

    const shape = shapeOf(editor, blockId);
    expect(shape.composed).toBe('zeta summary');
    // The only run is still fully bold — only its text changed.
    expect(shape.runs).toEqual([{ text: 'zeta summary', marks: ['bold'] }]);
    expect(editor.document[0].type).toBe('heading');
    expect((editor.document[0] as any).props.level).toBe(2);
  });

  test('a replacement spanning runs lands unstyled while the neighbors keep theirs', () => {
    const editor = editorWith([
      {
        type: 'paragraph',
        content: [text('plain '), text('alpha', { bold: true }), text(' tail', { italic: true })],
      },
    ]);
    const blockId = editor.document[0].id;

    // The match crosses two runs with different marks: the written text is
    // plain (marksAcross), the untouched runs keep bold/italic exactly.
    const applied = applySummaryReplacements(editor, [
      { blockId, from: 0, to: 11, expected: 'plain alpha', replacement: 'Zeta' },
    ]);
    expect(applied).toBe(true);

    const shape = shapeOf(editor, blockId);
    expect(shape.composed).toBe('Zeta tail');
    expect(shape.runs).toEqual([
      { text: 'Zeta', marks: [] },
      { text: ' tail', marks: ['italic'] },
    ]);
  });

  test('a replacement inside linked text keeps the link', () => {
    const editor = editorWith([
      {
        type: 'paragraph',
        content: [
          text('see '),
          { type: 'link', href: 'https://example.com', content: [text('alpha docs')] },
        ],
      },
    ]);
    const blockId = editor.document[0].id;

    const applied = applySummaryReplacements(editor, [
      { blockId, from: 4, to: 9, expected: 'alpha', replacement: 'zeta' },
    ]);
    expect(applied).toBe(true);

    const shape = shapeOf(editor, blockId);
    expect(shape.composed).toBe('see zeta docs');
    // The link mark still covers the whole linked run, replaced text included.
    expect(shape.runs).toEqual([
      { text: 'see ', marks: [] },
      { text: 'zeta docs', marks: ['link'] },
    ]);
  });

  test('every match of a block is spliced in one pass, right to left', () => {
    const editor = editorWith([
      { type: 'bulletListItem', content: [text('beta one and beta two', { bold: true })] },
    ]);
    const blockId = editor.document[0].id;

    const applied = applySummaryReplacements(editor, [
      { blockId, from: 0, to: 4, expected: 'beta', replacement: 'Zeta' },
      { blockId, from: 13, to: 17, expected: 'beta', replacement: 'Zeta' },
    ]);
    expect(applied).toBe(true);

    const shape = shapeOf(editor, blockId);
    expect(shape.composed).toBe('Zeta one and Zeta two');
    expect(shape.runs).toEqual([{ text: 'Zeta one and Zeta two', marks: ['bold'] }]);
  });

  test('an empty replacement deletes the matched text', () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('alpha beta gamma')] },
    ]);
    const blockId = editor.document[0].id;

    expect(applySummaryReplacements(editor, [
      { blockId, from: 6, to: 10, expected: 'beta', replacement: '' },
    ])).toBe(true);
    expect(shapeOf(editor, blockId).composed).toBe('alpha  gamma');
  });

  test('edits across blocks all land, list nesting intact', () => {
    const editor = editorWith([
      { type: 'bulletListItem', content: [text('alpha item')] },
      { type: 'bulletListItem', content: [text('second alpha')] },
    ]);
    const [first, second] = editor.document;

    expect(applySummaryReplacements(editor, [
      { blockId: first.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
      { blockId: second.id, from: 7, to: 12, expected: 'alpha', replacement: 'zeta' },
    ])).toBe(true);

    expect(buildBlockNoteSummaryBlocks(editor.document)).toEqual([
      { blockId: first.id, text: 'zeta item' },
      { blockId: second.id, text: 'second zeta' },
    ]);
    expect(editor.document.map(block => block.type)).toEqual(['bulletListItem', 'bulletListItem']);
  });

  test('a stale expected text aborts the whole call — nothing changes', async () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('alpha first')] },
      { type: 'paragraph', content: [text('alpha second')] },
    ]);
    const [first, second] = editor.document;

    // The second edit describes text that is not there (the user edited it in
    // between): the atomic rule makes the whole call a no-op — the first
    // block is NOT half-replaced.
    const applied = applySummaryReplacements(editor, [
      { blockId: first.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
      { blockId: second.id, from: 7, to: 12, expected: 'nothere', replacement: 'zeta' },
    ]);
    expect(applied).toBe(false);
    expect(buildBlockNoteSummaryBlocks(editor.document)).toEqual([
      { blockId: first.id, text: 'alpha first' },
      { blockId: second.id, text: 'alpha second' },
    ]);
  });

  test('a vanished block aborts the call without touching the doc', () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('alpha stays')] },
    ]);
    const blockId = editor.document[0].id;

    expect(applySummaryReplacements(editor, [
      { blockId: 'deleted-block', from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
      { blockId, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
    ])).toBe(false);
    expect(shapeOf(editor, blockId).composed).toBe('alpha stays');
  });

  test('an empty edit list succeeds without a change', () => {
    const editor = editorWith([{ type: 'paragraph', content: [text('untouched')] }]);
    expect(applySummaryReplacements(editor, [])).toBe(true);
    expect(shapeOf(editor, editor.document[0].id).composed).toBe('untouched');
  });

  test('every edit of a batch lands in ONE transaction — one dirty change, one undo step', () => {
    // The dirty mechanism (handleEditorChange → setIsDirty) and undo both
    // ride the number of dispatched transactions: «Заменить все» must read
    // as one user-sized change, not one per match. A fake editor counts the
    // transact calls; the real BlockNote transact dispatches once per call.
    let transactCalls = 0;
    const real = editorWith([
      { type: 'paragraph', content: [text('alpha one')] },
      { type: 'paragraph', content: [text('alpha two')] },
      { type: 'paragraph', content: [text('alpha three')] },
    ]);
    const [a, b, c] = real.document;
    const countingEditor = {
      get prosemirrorState() {
        return (real as any).prosemirrorState;
      },
      transact: (callback: (tr: any) => unknown) => {
        transactCalls += 1;
        return (real as any).transact(callback);
      },
    };

    applySummaryReplacements(countingEditor, [
      { blockId: a.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
      { blockId: b.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
      { blockId: c.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
    ]);

    expect(transactCalls).toBe(1);
    expect(buildBlockNoteSummaryBlocks(real.document).map(block => block.text)).toEqual([
      'zeta one',
      'zeta two',
      'zeta three',
    ]);
  });

  test('a dirty editor keeps its unsaved edits; only the match range changes', () => {
    const editor = editorWith([
      { type: 'paragraph', content: [text('alpha planned')] },
      { type: 'paragraph', content: [text('original second')] },
    ]);
    const [first, second] = editor.document;

    // The user types unsaved text into another block (what typing does).
    // Positions are read OUTSIDE the transact — BlockNote forbids
    // `prosemirrorState` inside one.
    const userTextPos = findBlockTextPos(editor, second.id);
    installDomStub();
    try {
      editor.transact(tr => {
        tr.insertText(' — edited by user', userTextPos + 'original second'.length);
      });
    } finally {
      restoreDomStub();
    }

    // Replace in the FIRST block: the user's unsaved text in the second block
    // survives untouched; the editor does not crash or revert.
    expect(applySummaryReplacements(editor, [
      { blockId: first.id, from: 0, to: 5, expected: 'alpha', replacement: 'zeta' },
    ])).toBe(true);
    expect(buildBlockNoteSummaryBlocks(editor.document)).toEqual([
      { blockId: first.id, text: 'zeta planned' },
      { blockId: second.id, text: 'original second — edited by user' },
    ]);
  });
});

/** The PM position where the block's own text begins (test helper). */
function findBlockTextPos(editor: BNEditor, blockId: string): number {
  const entries: any[] = [];
  (editor as any).prosemirrorState.doc.forEach((node: any, pos: number) => entries.push(reveal.toPMBlockEntry(node, pos)));
  const mapped = reveal.mapBlockTextRangeToPositions(entries, blockId, 0, 1);
  if (!mapped) throw new Error('helper could not locate the block text');
  return mapped.from;
}

/**
 * The legacy summary has no editor: its searchable text is each block's
 * plain `content`, and a replacement is the same splices verified against
 * `expected`. This is the pure core of the view's legacy replaceSummary —
 * tested here at the lib seam because the component suites in this process
 * hold a stubbed BlockNoteSummaryView (the documented mock-pollution
 * convention), the same reason ticket 04 tests the legacy block flattening
 * as a plain function.
 */
const { applyLegacySummaryReplacements } = await import('../../src/lib/summary-find-replace');

describe('applyLegacySummaryReplacements', () => {
  const legacy = () => ({
    MeetingName: 'Standup',
    _section_order: ['overview'],
    overview: {
      title: 'Overview',
      blocks: [
        { id: 'overview-1', type: 'heading1', content: 'alpha decisions', color: 'default' },
        { id: 'overview-2', type: 'bullet', content: 'beta owner and Alpha tail', color: 'default' },
      ],
    },
  });

  test('a replace splices the block content, keeping type and color', () => {
    const next = applyLegacySummaryReplacements(legacy(), [
      { blockId: 'overview-1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
    ]);
    expect(next).not.toBeNull();
    expect((next as any).overview.blocks.map((block: any) => block.content)).toEqual([
      'Zeta decisions',
      'beta owner and Alpha tail',
    ]);
    // The legacy formatting is the block type and color: untouched.
    expect((next as any).overview.blocks[0]).toMatchObject({ type: 'heading1', color: 'default' });
    // Non-section entries carry over untouched.
    expect((next as any).MeetingName).toBe('Standup');
    expect((next as any)._section_order).toEqual(['overview']);
  });

  test('several edits across blocks land together, offsets staying honest', () => {
    const next = applyLegacySummaryReplacements(legacy(), [
      { blockId: 'overview-2', from: 0, to: 4, expected: 'beta', replacement: 'Zeta' },
      { blockId: 'overview-2', from: 15, to: 20, expected: 'Alpha', replacement: 'Zeta' },
      { blockId: 'overview-1', from: 0, to: 5, expected: 'alpha', replacement: 'Ypsilon' },
    ] as SummaryReplaceEdit[]);
    expect(next).not.toBeNull();
    expect((next as any).overview.blocks.map((block: any) => block.content)).toEqual([
      'Ypsilon decisions',
      'Zeta owner and Zeta tail',
    ]);
  });

  test('a stale expected text aborts the whole batch', () => {
    expect(applyLegacySummaryReplacements(legacy(), [
      { blockId: 'overview-1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
      { blockId: 'overview-2', from: 0, to: 4, expected: 'nothere', replacement: 'Zeta' },
    ])).toBeNull();
  });

  test('a vanished block id aborts the batch', () => {
    expect(applyLegacySummaryReplacements(legacy(), [
      { blockId: 'deleted-block', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
    ])).toBeNull();
  });

  test('a delete replacement empties the matched text', () => {
    const next = applyLegacySummaryReplacements(legacy(), [
      { blockId: 'overview-2', from: 0, to: 5, expected: 'beta ', replacement: '' },
    ]);
    expect((next as any).overview.blocks[1].content).toBe('owner and Alpha tail');
  });

  test('the input summary is never mutated', () => {
    const before = legacy();
    applyLegacySummaryReplacements(before, [
      { blockId: 'overview-1', from: 0, to: 5, expected: 'alpha', replacement: 'Zeta' },
    ]);
    expect(before.overview.blocks[0].content).toBe('alpha decisions');
  });

  test('an empty edit list returns the same summary, unchanged', () => {
    const before = legacy();
    expect(applyLegacySummaryReplacements(before, [])).toBe(before);
  });

  test('a non-object summary aborts the batch', () => {
    expect(applyLegacySummaryReplacements(null, [
      { blockId: 'x', from: 0, to: 1, expected: 'a', replacement: 'b' },
    ])).toBeNull();
  });
});
