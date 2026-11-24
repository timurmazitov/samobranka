import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * The summary's find-match highlighting as a raw ProseMirror plugin.
 *
 * BlockNote 0.36 has no decorations API (`editor.ui.buildEditorDecorations`
 * does not exist), so highlights come from the supported extension point: a
 * `BlockNoteExtension` subclass registering this plugin via
 * `addProsemirrorPlugin` — see `components/BlockNoteEditor/FindHighlightExtension.ts`.
 * The plugin is a plain `DecorationSet` state field: the summary surface
 * sets the match ranges with a meta transaction (the caller maps block and
 * offset ranges to document positions first — see `summary-find-reveal`),
 * and any other transaction just remaps the set, so highlights follow edits
 * until the next query recomputes them.
 *
 * Deliberately free of any `@blocknote/core` import: that package's CSS
 * side effect must stay off the headless test/lib module graph.
 *
 * Decorations are inline span wrappers only: they style, never mutate, so
 * the summary's headings, lists, and marks are untouched while highlighting
 * (the ticket's formatting requirement).
 */

/** One match in document positions (already mapped from block/offset). */
export interface FindHighlightRange {
  from: number;
  to: number;
  /** The panel's current match: drawn apart from the plain matches. */
  active: boolean;
}

/**
 * Shared classes: every match reads as a highlight; the active one is
 * visually distinct. Both are defined in globals.css next to `.ProseMirror`.
 */
export const FIND_MATCH_CLASS = 'find-replace-match';
export const FIND_MATCH_ACTIVE_CLASS = 'find-replace-match-active';

export const findHighlightKey = new PluginKey('samobranka-find-highlight');

function toDecoration(range: FindHighlightRange, doc: { content: { size: number } }) {
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) return null;
  if (range.from < 0 || range.to <= range.from || range.to > doc.content.size) return null;
  return Decoration.inline(range.from, range.to, {
    class: range.active ? `${FIND_MATCH_CLASS} ${FIND_MATCH_ACTIVE_CLASS}` : FIND_MATCH_CLASS,
  });
}

/** The PM plugin; the same shape for every editor instance. */
export function createFindHighlightPlugin(): Plugin {
  return new Plugin({
    key: findHighlightKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const ranges = tr.getMeta(findHighlightKey) as FindHighlightRange[] | undefined;
        if (ranges) {
          const decorations = ranges
            .map(range => toDecoration(range, tr.doc))
            .filter((decoration): decoration is Decoration => decoration !== null);
          return DecorationSet.create(tr.doc, decorations);
        }
        // No new list: the old one follows the document's own changes
        // (typing, replacing) so highlights never pin to stale positions.
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return findHighlightKey.getState(state) as DecorationSet | undefined;
      },
    },
  });
}
