import { describe, expect, test } from 'bun:test';

// prosemirror-view computes browser facts at module load and a sibling suite
// may be holding a partial `document` stub in the shared bun process (the
// known mock-pollution hazard). Install a complete-enough stub for the load
// and restore it right after — the values are cached at initialization, and
// nothing below touches the DOM afterwards.
const originalDocument = Reflect.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: {
    documentElement: { style: {} },
    head: { appendChild: () => {} },
    getElementsByTagName: () => [{ appendChild: () => {} }],
    createElement: () => ({ style: {}, appendChild: () => {}, setAttribute: () => {} }),
  },
});
const { Schema } = await import('@tiptap/pm/model');
const { EditorState, Plugin } = await import('@tiptap/pm/state');
const { DecorationSet } = await import('@tiptap/pm/view');
// The real BlockNote extension subclass, loaded while the DOM stub is up:
// @blocknote/core's CSS injection needs `document.head`. The wiring test
// below asserts against the real `plugins` getter — the same value the
// editor consumes at creation.
const { FindHighlightExtension } = await import(
  '../../src/components/BlockNoteEditor/FindHighlightExtension'
);
if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
else Reflect.deleteProperty(globalThis, 'document');

// Type-only aliases: the dynamic imports above are values, and bun's loader
// runs them after the stub is installed.
type EditorStateLike = import('@tiptap/pm/state').EditorState;
type DecorationSetLike = import('@tiptap/pm/view').DecorationSet;

import {
  createFindHighlightPlugin,
  findHighlightKey,
  type FindHighlightRange,
} from '../../src/lib/summary-find-decorations';

/**
 * The summary's match highlighting as a ProseMirror plugin (BlockNote 0.36
 * has no decorations API, so this is the raw-PM path the extension point is
 * designed for). Verified against the REAL ProseMirror model and state —
 * the plugin contract is: set ranges via a meta transaction, non-active and
 * active matches get visually distinct classes, decorations follow doc
 * edits through mapping, and clearing empties the set. This is the logic
 * that decides what the user sees under the active match; the CSS behind
 * each class is checked in tauri:dev.
 */

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      content: 'text*',
      group: 'block',
      attrs: { id: { default: null } },
    },
    text: {},
  },
});

const doc = schema.topNodeType.create(null, [
  schema.nodes.paragraph.create({ id: 'b1' }, [schema.text('Hello '), schema.text('world')]),
  schema.nodes.paragraph.create({ id: 'b2' }, [schema.text('alpha beta')]),
]);
// «Hello world» block: content starts at 1, «world» spans 7..12.
// «alpha beta» block: content starts at 15, «alpha» spans 15..20.

function stateWith(plugin: ReturnType<typeof createFindHighlightPlugin>) {
  return EditorState.create({ doc, plugins: [plugin] });
}

function decorationsOf(state: EditorStateLike) {
  const set = findHighlightKey.getState(state);
  expect(set).toBeInstanceOf(DecorationSet);
  return (set as DecorationSetLike).find(0, doc.content.size);
}

describe('find highlight plugin', () => {
  test('meta transaction installs one decoration per range with distinct classes', () => {
    const plugin = createFindHighlightPlugin();
    const state = stateWith(plugin);

    const ranges: FindHighlightRange[] = [
      { from: 7, to: 12, active: false }, // «world»
      { from: 15, to: 20, active: true }, // «alpha», the active match
    ];
    const next = state.apply(state.tr.setMeta(findHighlightKey, ranges));

    const decorations = decorationsOf(next);
    expect(decorations).toHaveLength(2);

    // The class rides on the decoration's DOM attrs (Decoration.inline's
    // attrs argument): non-active vs active must be visually distinct.
    const classOf = (decoration: unknown) =>
      (decoration as { type: { attrs: { class?: string } } }).type.attrs.class ?? '';
    const first = decorations[0];
    const second = decorations[1];
    // Non-active vs active: visually distinct, as the ticket requires.
    expect(classOf(first)).toContain('find-replace-match');
    expect(classOf(first)).not.toContain('active');
    expect(classOf(second)).toContain('find-replace-match');
    expect(classOf(second)).toContain('active');
  });

  test('an empty or absent range list highlights nothing', () => {
    const plugin = createFindHighlightPlugin();
    const state = stateWith(plugin);

    const withOne = state.apply(
      state.tr.setMeta(findHighlightKey, [{ from: 7, to: 12, active: false }]),
    );
    expect(decorationsOf(withOne)).toHaveLength(1);

    const cleared = withOne.apply(withOne.tr.setMeta(findHighlightKey, []));
    expect(decorationsOf(cleared)).toHaveLength(0);
  });

  test('invalid ranges are dropped, never crash the state field', () => {
    const plugin = createFindHighlightPlugin();
    const state = stateWith(plugin);

    const next = state.apply(
      state.tr.setMeta(findHighlightKey, [
        { from: 7, to: 12, active: false }, // good
        { from: 12, to: 7, active: false }, // inverted
        { from: -3, to: 2, active: false }, // negative
        { from: 300, to: 400, active: false }, // past the doc
      ]),
    );
    expect(decorationsOf(next)).toHaveLength(1);
  });

  test('a transaction without meta and without a doc change keeps the set', () => {
    const plugin = createFindHighlightPlugin();
    const state = stateWith(plugin);
    const marked = state.apply(state.tr.setMeta(findHighlightKey, [{ from: 7, to: 12, active: false }]));

    // A pure selection move (no meta): the highlight survives untouched.
    const moved = marked.apply(marked.tr);
    expect(decorationsOf(moved)).toHaveLength(1);
  });

  test('a doc edit before a match shifts it; an edit inside it drops it', () => {
    const plugin = createFindHighlightPlugin();
    const state = stateWith(plugin);
    const marked = state.apply(
      state.tr.setMeta(findHighlightKey, [
        { from: 7, to: 12, active: false }, // «world»
        { from: 15, to: 20, active: false }, // «alpha»
      ]),
    );

    // Insert «Hey » before the marked text: positions shift by 4 and the
    // decoration must move with the text, not stay pinned to the old span.
    const afterInsert = marked.apply(marked.tr.insertText('Hey ', 1));
    const moved = decorationsOf(afterInsert) as unknown as Array<{ from: number; to: number }>;
    expect(moved).toHaveLength(2);
    expect(moved.map(d => [d.from, d.to])).toEqual([[11, 16], [19, 24]]);

    // Replace the marked text itself: the decoration inside the replaced
    // range is removed with it, while the other one survives.
    const afterDelete = marked.apply(marked.tr.delete(7, 12));
    expect(decorationsOf(afterDelete)).toHaveLength(1);
  });
});

describe('FindHighlightExtension', () => {
  test('registers the highlight plugin through the BlockNote extension point', () => {
    // The 0.36 way to hand a PM plugin to the editor: subclass
    // BlockNoteExtension, call addProsemirrorPlugin — the `plugins` getter
    // is what the editor consumes at creation, fed by exactly that call.
    const extension = new FindHighlightExtension();
    expect(extension.plugins).toHaveLength(1);
    expect(extension.plugins[0]).toBeInstanceOf(Plugin);
  });
});


