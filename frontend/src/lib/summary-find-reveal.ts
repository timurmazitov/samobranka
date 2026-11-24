import type { Node } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

import { findHighlightKey } from './summary-find-decorations';

/**
 * Position mapping for the summary's active-match highlight.
 *
 * BlockNote 0.36 has no decorations API (`editor.ui.buildEditorDecorations`
 * does not exist), and the sanctioned fallback (spec: «фолбэк, если
 * decorations окажутся хрупкими») highlights the active match through the
 * editor selection. Either way the one hard part is the same pure problem:
 * map a match's [from, to) offsets inside one block's concatenated text to
 * ProseMirror document positions, where the block is addressed by its
 * BlockNote id.
 *
 * The shape mirrors the BlockNote 0.36 PM model: block nodes carry their
 * BlockNote id in `attrs.id`; a block's own text lives in its text
 * descendants and its children start one past the block node's start;
 * nested blocks are separate block nodes whose text belongs to THEM, so a
 * parent's searchable text (the same composition `buildBlockNoteSummaryBlocks`
 * makes) never counts a nested block's characters.
 *
 * Plain-object node views (`PMBlockNode`) keep this testable without a DOM;
 * the caller adapts real PM nodes with `toPMBlockEntry`.
 */

export interface PMBlockNode {
  isText?: boolean;
  isBlock?: boolean;
  attrs?: Record<string, unknown>;
  text?: string;
  children?: PMBlockNode[];
}

/** A top-level block as ProseMirror's `descendants` reports it: node + start. */
export interface PMBlockEntry {
  node: PMBlockNode;
  pos: number;
}

interface TextRun {
  /** PM position where this run's text begins. */
  pos: number;
  text: string;
}

function nodeSize(node: PMBlockNode): number {
  if (node.isText) return node.text?.length ?? 0;
  return (node.children ?? []).reduce((size, child) => size + nodeSize(child), 0) + 2;
}

/**
 * The block's own text runs in order: text descendants of the node, without
 * descending into nested block nodes (their text belongs to the child block).
 */
function collectOwnTextRuns(node: PMBlockNode, contentStart: number): TextRun[] {
  const runs: TextRun[] = [];
  let pos = contentStart;
  for (const child of node.children ?? []) {
    if (child.isText) {
      runs.push({ pos, text: child.text ?? '' });
      pos += child.text?.length ?? 0;
    } else if (child.isBlock) {
      // Nested block: consumes its full node size but contributes no text
      // to this block's searchable text.
      pos += nodeSize(child);
    } else {
      // Non-block inline wrapper (defensive: links are marks in PM, not
      // nodes): descend — its text belongs to this block.
      const nested = collectOwnTextRuns(child, pos);
      runs.push(...nested);
      pos += nodeSize(child) - 2;
    }
  }
  return runs;
}

function mapWithinRuns(runs: TextRun[], from: number, to: number): { from: number; to: number } | null {
  let offset = 0;
  let startPosition: number | null = null;
  let endPosition: number | null = null;
  for (const run of runs) {
    const length = run.text.length;
    if (startPosition === null && from >= offset && from < offset + length) {
      startPosition = run.pos + (from - offset);
    }
    if (endPosition === null && to > offset && to <= offset + length) {
      endPosition = run.pos + (to - offset);
    }
    offset += length;
  }
  // `to` sitting exactly at the total end is valid and lands at the last
  // run's end; a `from` past the text (or an unclosed range) maps to null.
  if (startPosition === null || endPosition === null) return null;
  return { from: startPosition, to: endPosition };
}

/**
 * Map [from, to) inside the block `blockId`'s concatenated text to PM
 * positions, searching the top-level entries (and their nested blocks) in
 * document order. Returns null when the block is absent or the range does
 * not sit inside the block's own text — callers then skip the reveal rather
 * than move the cursor somewhere wrong.
 */
export function mapBlockTextRangeToPositions(
  entries: readonly PMBlockEntry[],
  blockId: string,
  from: number,
  to: number,
): { from: number; to: number } | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from) {
    return null;
  }

  const search = (node: PMBlockNode, contentStart: number): { from: number; to: number } | null => {
    if (node.attrs?.id === blockId) {
      return mapWithinRuns(collectOwnTextRuns(node, contentStart), from, to);
    }
    let pos = contentStart;
    for (const child of node.children ?? []) {
      if (child.isBlock) {
        const result = search(child, pos + 1);
        if (result) return result;
        pos += nodeSize(child);
      } else if (!child.isText) {
        const result = search(child, pos);
        if (result) return result;
        pos += nodeSize(child) - 2;
      } else {
        pos += child.text?.length ?? 0;
      }
    }
    return null;
  };

  for (const entry of entries) {
    const result = search(entry.node, entry.pos + 1);
    if (result) return result;
  }
  return null;
}

/** Adapt a real PM node (and its subtree) to the testable plain shape. */
export function toPMBlockEntry(node: Node, pos: number): PMBlockEntry {
  const convert = (n: Node): PMBlockNode => {
    if (n.isText) return { isText: true, text: n.text ?? '' };
    const children: PMBlockNode[] = [];
    n.forEach(child => children.push(convert(child)));
    return { isBlock: n.isBlock, attrs: n.attrs as Record<string, unknown>, children };
  };
  return { node: convert(node), pos };
}

/** One summary match as the find panel reports it (block/offset space). */
export interface SummaryFindMatch {
  blockId: string;
  from: number;
  to: number;
}

/** The members of BlockNoteEditor the reveal touches; the PM view is only
 * needed to scroll the active match into view. */
interface HighlightDispatchEditor {
  prosemirrorState: EditorState;
  prosemirrorView?: {
    domAtPos(pos: number): { node: unknown };
  };
  exec(command: (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean): boolean;
}

/**
 * Push the summary's match list into the find-highlight plugin: map every
 * match from block/offset space to document positions, mark the active one,
 * and hand the set to the plugin in one meta transaction. Matches whose
 * block or offsets no longer resolve (an edit landed between the query and
 * the reveal) are dropped rather than revealed somewhere wrong; an empty
 * list dispatches an empty set, clearing the highlights.
 *
 * Takes the two members of BlockNoteEditor it needs, so the call site stays
 * a one-liner and the mapping is testable against a bare PM state.
 */
export function applyFindHighlights(
  editor: HighlightDispatchEditor,
  matches: readonly SummaryFindMatch[],
  activeIndex: number,
): void {
  const entries: PMBlockEntry[] = [];
  editor.prosemirrorState.doc.forEach((node, pos) => entries.push(toPMBlockEntry(node, pos)));

  // findHighlightKey must be the plugin's own key — imported lazily to keep
  // this module free of the plugin's view dependency at type level.
  const ranges = matches
    .map((match, index) => {
      const positions = mapBlockTextRangeToPositions(entries, match.blockId, match.from, match.to);
      if (!positions) return null;
      return { from: positions.from, to: positions.to, active: index === activeIndex };
    })
    .filter((range): range is { from: number; to: number; active: boolean } => range !== null);

  editor.exec((state, dispatch) => {
    if (dispatch) {
      dispatch(state.tr.setMeta(findHighlightKey, ranges));
    }
    return true;
  });

  // Follow the active match into view (the panel is non-modal, so the text
  // must scroll to it). The midpoint lands inside the match rather than on
  // its edge; without a mounted view (headless) or a mappable active match
  // there is nothing to scroll.
  const active = activeIndex >= 0 ? ranges[activeIndex] : undefined;
  if (active && editor.prosemirrorView) {
    const { node } = editor.prosemirrorView.domAtPos(Math.floor((active.from + active.to) / 2));
    const scrollTarget =
      node && typeof (node as { scrollIntoView?: unknown }).scrollIntoView === 'function'
        ? (node as { scrollIntoView: (options: ScrollIntoViewOptions) => void })
        : (node as { parentElement?: { scrollIntoView?: (options: ScrollIntoViewOptions) => void } })?.parentElement;
    scrollTarget?.scrollIntoView?.({ block: 'center' });
  }
}
