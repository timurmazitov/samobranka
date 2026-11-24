import { describe, expect, mock, test } from 'bun:test';

// Same DOM-stub guard as the decorations suite: this file's module chain
// (summary-find-reveal → summary-find-decorations → prosemirror-view) reads
// browser facts at load, and a sibling suite may hold a partial `document`
// stub in the shared bun process.
const originalDocument = Reflect.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: { style: {} },
    head: {},
    getElementsByTagName: () => [],
    createElement: () => ({ style: {} }),
  },
});
const { Schema } = await import('@tiptap/pm/model');
const { EditorState, Plugin } = await import('@tiptap/pm/state');
const {
  applyFindHighlights,
  mapBlockTextRangeToPositions,
  toPMBlockEntry,
} = await import('../../src/lib/summary-find-reveal');
const { findHighlightKey } = await import('../../src/lib/summary-find-decorations');
if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
else Reflect.deleteProperty(globalThis, 'document');

type PMBlockNode = import('../../src/lib/summary-find-reveal').PMBlockNode;
type SummaryFindMatch = import('../../src/lib/summary-find-reveal').SummaryFindMatch;
type Transaction = import('@tiptap/pm/state').Transaction;
type EditorStateLike = import('@tiptap/pm/state').EditorState;
type PMNodeType = import('@tiptap/pm/model').Node;

/**
 * The summary reveal's position mapping: map a match's [from, to) offsets
 * inside one block's concatenated text to ProseMirror document positions,
 * with the block addressed by its BlockNote id.
 *
 * The mock nodes stand in for prosemirror-model nodes with the same shape so
 * the mapping arithmetic — the part that can be wrong silently — is
 * verified without a DOM. The `applyFindHighlights` cases run against a
 * REAL ProseMirror state so the mapping is checked end to end.
 */

const text = (t: string): PMBlockNode => ({ isText: true, text: t });
const block = (id: string, children: PMBlockNode[]): PMBlockNode => ({
  isText: false,
  isBlock: true,
  attrs: { id },
  children,
});

function nodeSize(node: PMBlockNode): number {
  if (node.isText) return node.text?.length ?? 0;
  return (node.children ?? []).reduce((size, child) => size + nodeSize(child), 0);
}

/** Top-level block entries like PM `descendants` reports: the node and its
 * start position; the block's content starts one past it. */
function doc(blocks: PMBlockNode[]) {
  let pos = 0;
  return blocks.map(b => {
    const entry = { node: b, pos };
    pos += 2 + nodeSize(b); // open token + children + close token
    return entry;
  });
}

describe('mapBlockTextRangeToPositions', () => {
  test('maps a range inside one block through its text runs', () => {
    const blocks = doc([block('b1', [text('Hello '), text('world')])]);

    // «world» inside «Hello world»: offsets 6..11 → the second run's span.
    expect(mapBlockTextRangeToPositions(blocks, 'b1', 6, 11)).toEqual({ from: 7, to: 12 });
    // A range inside the first run too.
    expect(mapBlockTextRangeToPositions(blocks, 'b1', 0, 5)).toEqual({ from: 1, to: 6 });
  });

  test('excludes nested block text from the parent block', () => {
    // A parent block with its own text plus a nested block: the parent's
    // searchable text is only its own runs, so a range there must not count
    // the nested block's characters toward offsets.
    const blocks = doc([
      block('outer', [
        text('outer'),
        block('nested', [text('nested')]),
        text(' tail'),
      ]),
    ]);

    // «outer» occupies the parent's offsets 0..5 and lives at the block's
    // content start regardless of the sibling nested block.
    expect(mapBlockTextRangeToPositions(blocks, 'outer', 0, 5)).toEqual({ from: 1, to: 6 });
    // The parent's whole text is «outer tail» (10 chars). The trailing run
    // sits AFTER the nested block node (which swallows positions 6..14), so
    // « tail» (offsets 5..10) maps past it — the nested block's own «nested»
    // text contributes nothing to the parent's offsets.
    expect(mapBlockTextRangeToPositions(blocks, 'outer', 5, 10)).toEqual({ from: 14, to: 19 });
    // Offsets past the parent's own text are invalid.
    expect(mapBlockTextRangeToPositions(blocks, 'outer', 10, 16)).toBeNull();
  });

  test('finds a nested block by its own id and maps inside it', () => {
    const blocks = doc([
      block('outer', [text('outer'), block('nested', [text('one '), text('two')])]),
    ]);

    // The nested block node starts after «outer» at position 6, its runs
    // «one » (7..11) and «two» (11..14). The block's text is «one two»,
    // so offsets 4..7 («two») map to 11..14.
    expect(mapBlockTextRangeToPositions(blocks, 'nested', 4, 7)).toEqual({ from: 11, to: 14 });
  });

  test('returns null when the block id is absent', () => {
    const blocks = doc([block('b1', [text('only')])]);
    expect(mapBlockTextRangeToPositions(blocks, 'missing', 0, 4)).toBeNull();
  });

  test('rejects ranges outside the block text or malformed', () => {
    const blocks = doc([block('b1', [text('four')])]);
    expect(mapBlockTextRangeToPositions(blocks, 'b1', 2, 9)).toBeNull(); // past the end
    expect(mapBlockTextRangeToPositions(blocks, 'b1', 3, 2)).toBeNull(); // inverted
    expect(mapBlockTextRangeToPositions(blocks, 'b1', -1, 2)).toBeNull(); // negative
    expect(mapBlockTextRangeToPositions([], 'b1', 0, 1)).toBeNull(); // no doc
  });

  test('maps against a real PM doc and the slices come back exact', () => {
    const schema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'text*', group: 'block', attrs: { id: { default: null } } },
        text: {},
      },
    });
    const pmDoc = schema.topNodeType.create(null, [
      schema.nodes.paragraph.create({ id: 'b1' }, [schema.text('Hello '), schema.text('world')]),
    ]);
    const entries: { node: PMBlockNode; pos: number }[] = [];
    pmDoc.forEach((node: PMNodeType, pos: number) => entries.push(toPMBlockEntry(node, pos)));

    const mapped = mapBlockTextRangeToPositions(entries, 'b1', 6, 11);
    expect(mapped).not.toBeNull();
    // The PM doc's own slice proves the positions point where the block
    // text's offsets say they should.
    expect(pmDoc.textBetween(mapped!.from, mapped!.to)).toBe('world');
  });
});

describe('applyFindHighlights', () => {
  /**
   * The reveal contract at the editor boundary: given the live editor state
   * and the summary matches, every mappable range is dispatched once as
   * plugin meta, the active match is flagged, unmappable matches are dropped
   * (never revealed somewhere wrong), and an empty list clears the set. The
   * editor stands in for BlockNoteEditor with the same members the
   * implementation touches: the PM state and exec.
   */
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block', attrs: { id: { default: null } } },
      text: {},
    },
  });
  const pmDoc = schema.topNodeType.create(null, [
    schema.nodes.paragraph.create({ id: 'b1' }, [schema.text('Hello '), schema.text('world')]),
    schema.nodes.paragraph.create({ id: 'b2' }, [schema.text('alpha beta')]),
  ]);

  interface FakeEditor {
    prosemirrorState: EditorStateLike;
    exec: (command: (state: EditorStateLike, dispatch?: (tr: Transaction) => void) => boolean) => boolean;
  }

  function makeEditor() {
    const state = EditorState.create({
      doc: pmDoc,
      // The real highlight plugin rides along: getMeta on the dispatched
      // transaction is what the plugin's state field reads.
      plugins: [new Plugin({ key: findHighlightKey })],
    });
    const dispatched: Transaction[] = [];
    const editor: FakeEditor = {
      prosemirrorState: state,
      exec: command => command(state, tr => dispatched.push(tr)),
    };
    return { editor, dispatched };
  }

  test('maps each match, flags the active one, and dispatches plugin meta', () => {
    const { editor, dispatched } = makeEditor();
    const matches: SummaryFindMatch[] = [
      { blockId: 'b1', from: 6, to: 11 }, // «world»
      { blockId: 'b2', from: 0, to: 5 }, // «alpha» — the active match
    ];

    applyFindHighlights(editor, matches, 1);

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].getMeta(findHighlightKey)).toEqual([
      { from: 7, to: 12, active: false },
      { from: 14, to: 19, active: true },
    ]);
  });

  test('unmappable matches are dropped', () => {
    const { editor, dispatched } = makeEditor();

    applyFindHighlights(editor, [
      { blockId: 'b1', from: 100, to: 105 }, // outside the block text
      { blockId: 'gone', from: 0, to: 1 }, // block not in the doc
    ], 1);

    expect(dispatched[0].getMeta(findHighlightKey)).toEqual([]);
  });

  test('an empty match list dispatches an empty set to clear highlights', () => {
    const { editor, dispatched } = makeEditor();

    applyFindHighlights(editor, [], -1);

    expect(dispatched[0].getMeta(findHighlightKey)).toEqual([]);
  });

  test('the active match scrolls its DOM position into view', () => {
    const { editor } = makeEditor();
    // The PM view stand-in: domAtPos answers with an element node, and the
    // reveal's whole scroll contract is that it centers that position.
    const scrolled: Array<{ pos: number; block: string }> = [];
    const withView = {
      ...editor,
      prosemirrorView: {
        domAtPos: (pos: number) => ({
          node: { nodeType: 1, scrollIntoView: (options: { block?: string }) => scrolled.push({ pos, block: options?.block ?? '' }) },
        }),
      },
    };

    applyFindHighlights(withView, [
      { blockId: 'b1', from: 6, to: 11 }, // mapped 7..12
      { blockId: 'b2', from: 0, to: 5 }, // mapped 14..19 — active
    ], 1);

    // The active range's midpoint, not its edge: a position inside the match.
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].pos).toBe(16);
    expect(scrolled[0].block).toBe('center');
  });

  test('no scroll happens without an active mappable match', () => {
    const { editor } = makeEditor();
    const scroll = mock(() => {});
    const withView = {
      ...editor,
      prosemirrorView: {
        domAtPos: () => ({ node: { nodeType: 1, scrollIntoView: scroll } }),
      },
    };

    applyFindHighlights(withView, [{ blockId: 'b1', from: 6, to: 11 }], -1);
    expect(scroll).not.toHaveBeenCalled();

    applyFindHighlights(withView, [{ blockId: 'gone', from: 0, to: 1 }], 0);
    expect(scroll).not.toHaveBeenCalled();
  });
});
