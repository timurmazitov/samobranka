import type { EditorState, Transaction } from '@tiptap/pm/state';

import { mapBlockTextRangeToPositions, toPMBlockEntry, type PMBlockEntry } from './summary-find-reveal';

/**
 * Summary text replacement for the find & replace panel (ticket 05).
 *
 * The spec's rule: a replacement edits only the text inside a match — the
 * block's type (heading, list item), nesting, marks and links survive. The
 * BlockNote 0.36 way is the raw ProseMirror path: map the block's [from, to)
 * offsets to document positions (the same mapping the highlight reveal
 * uses), then splice text with `tr.insertText` / `tr.delete` inside a single
 * `editor.transact` — one dispatch, so BlockNote's dirty mechanism sees one
 * user-sized change and save persists it through the existing path.
 *
 * Mark preservation is PM's own rule (prosemirror-state Transaction
 * .insertText): text written across a range takes the marks that span the
 * whole range, so a replacement inside one styled run comes back styled and
 * a match crossing differently-styled runs lands plain, never half-applied
 * styling. This is why text splicing beats rebuilding the block's inline
 * content — the runs that are not touched are never rewritten.
 *
 * Atomicity: every edit carries the `expected` text its range matched
 * against. A range whose doc text no longer says that (the user edited the
 * block between the query and the click) aborts the WHOLE call without
 * touching the document — a half-applied «replace all» is never written,
 * and the panel's next recompute shows the real text.
 *
 * Deliberately free of any `@blocknote/core` import (the decorations module
 * set the precedent): the headless/lib module graph stays CSS-free, and the
 * editor is reached through the two members this needs.
 */

/** One replacement, in block/offset space — what a summary Match describes. */
export interface SummaryReplaceEdit {
  /** The BlockNote block id (or a legacy block id at the caller level). */
  blockId: string;
  /** Start index in the block's composed text (inclusive). */
  from: number;
  /** End index in the block's composed text (exclusive). */
  to: number;
  /** The text `from..to` held when the match was built. */
  expected: string;
  /** What to write there; '' deletes the matched text. */
  replacement: string;
}

/** The members of BlockNoteEditor the replacement touches. */
interface ReplaceEditorLike {
  prosemirrorState: EditorState;
  transact<T>(callback: (tr: Transaction) => T): T;
}

/**
 * Apply all summary edits as one editor transaction. Returns false — with
 * the document untouched — when any edit's range no longer holds its
 * `expected` text or its block is gone; returns true (with no change at all
 * dispatched) for an empty edit list, like `editor.transact` itself.
 */
export function applySummaryReplacements(
  editor: ReplaceEditorLike,
  edits: readonly SummaryReplaceEdit[],
): boolean {
  if (edits.length === 0) return true;

  // Plan against the current doc, before opening the transaction.
  const entries: PMBlockEntry[] = [];
  editor.prosemirrorState.doc.forEach((node, pos) => entries.push(toPMBlockEntry(node, pos)));

  const planned: Array<{ from: number; to: number; edit: SummaryReplaceEdit }> = [];
  for (const edit of edits) {
    const positions = mapBlockTextRangeToPositions(entries, edit.blockId, edit.from, edit.to);
    if (!positions) return false;
    // The honesty gate: the range must still say exactly what the match
    // matched. textBetween over an in-block range is the plain text there —
    // the same composition the match list scanned.
    if (editor.prosemirrorState.doc.textBetween(positions.from, positions.to) !== edit.expected) {
      return false;
    }
    planned.push({ ...positions, edit });
  }

  // Splice right to left: earlier positions are never shifted by a later
  // replacement, so every planned range still addresses what it was mapped
  // to when the transaction finally dispatches.
  planned.sort((a, b) => b.from - a.from);

  editor.transact(tr => {
    for (const { from, to, edit } of planned) {
      if (edit.replacement === '') {
        // Deletion via tr.delete (not deleteRange): a block emptied this way
        // stays a block — replace-all never deletes the user's paragraphs.
        tr.delete(from, to);
      } else {
        tr.insertText(edit.replacement, from, to);
      }
    }
  });
  return true;
}

/**
 * The legacy summary's replacement: no editor, so the searchable text is
 * each block's plain `content` string and a replacement is the same splices
 * — verified against `expected` first, with the same atomic rule (a stale
 * range aborts the whole batch, returning null and leaving the input
 * untouched, exactly like the PM path leaves the doc). The caller feeds the
 * returned object into the existing `onSummaryChange` chain, so the save
 * persists through the legacy path the block textareas already use. The
 * input summary is never mutated.
 */
export function applyLegacySummaryReplacements<T extends object>(
  summary: T | null | undefined,
  edits: readonly SummaryReplaceEdit[],
): T | null {
  if (edits.length === 0) return summary ?? null;
  if (!summary || typeof summary !== 'object') return null;

  // Verify every range against the current plain content first.
  const currentById = new Map<string, string>();
  for (const section of Object.values(summary as Record<string, unknown>)) {
    const blocks = (section as { blocks?: unknown })?.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const raw of blocks) {
      const block = raw as { id?: unknown; content?: unknown };
      if (typeof block?.id === 'string' && typeof block.content === 'string') {
        currentById.set(block.id, block.content);
      }
    }
  }
  for (const edit of edits) {
    const current = currentById.get(edit.blockId);
    if (current === undefined || current.slice(edit.from, edit.to) !== edit.expected) return null;
  }

  // Splice right to left per block so earlier offsets stay honest.
  const spliced = new Map<string, string>();
  for (const edit of [...edits].sort((a, b) => b.from - a.from)) {
    const current = spliced.get(edit.blockId) ?? currentById.get(edit.blockId)!;
    spliced.set(
      edit.blockId,
      current.slice(0, edit.from) + edit.replacement + current.slice(edit.to),
    );
  }

  // Rebuild the section map immutably: only touched blocks are replaced.
  const updated: Record<string, unknown> = {};
  for (const [sectionKey, section] of Object.entries(summary as Record<string, unknown>)) {
    const blocks = (section as { blocks?: unknown })?.blocks;
    if (!section || typeof section !== 'object' || !Array.isArray(blocks)) {
      updated[sectionKey] = section;
      continue;
    }
    updated[sectionKey] = {
      ...section,
      blocks: (blocks as Array<{ id?: unknown }>).map(block =>
        typeof block?.id === 'string' && spliced.has(block.id)
          ? { ...block, content: spliced.get(block.id) }
          : block,
      ),
    };
  }
  return updated as T;
}
