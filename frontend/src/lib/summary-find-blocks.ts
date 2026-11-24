/**
 * Block-shape readers for the summary's searchable text (find & replace,
 * ticket 04). Pure BlockNote/legacy model knowledge: they compose, for each
 * editor block, the one plain string the find panel matches against — the
 * same composition the reveal's position mapping (summary-find-reveal) maps
 * offsets through. The hook consumes the resulting blocks; the summary
 * surface reports them. Nothing here knows about matches, the panel, or React.
 */

/**
 * One searchable unit of the summary: a single text block and its composed
 * plain text. For BlockNote (and markdown, which parses into BlockNote) the
 * text concatenates the block's inline content; for legacy it is the block's
 * plain `content`. Matches never span blocks, so `from`/`to` are indices into
 * this one text (ticket 04).
 */
export interface SummaryBlock {
  blockId: string;
  text: string;
}

interface BlockNoteInlineLike {
  type?: string;
  text?: string;
  content?: unknown;
}

function inlineContentText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const node of content as BlockNoteInlineLike[]) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'text' && typeof node.text === 'string') {
      text += node.text;
    } else if (node.type === 'link') {
      // Links wrap their own styled-text runs; their text shows in the
      // editor, so the block's searchable text includes it.
      text += inlineContentText(node.content);
    }
  }
  return text;
}

interface BlockNoteBlockLike {
  id?: string;
  content?: unknown;
  children?: unknown;
}

/**
 * Flatten BlockNote blocks (the live `editor.document`, the same shape for
 * the blocknote and markdown formats) into searchable texts: each block's
 * inline content concatenated in order, nested blocks following their parent
 * in document order. Formatting is read off, never touched — this only
 * composes the text that the find panel matches against.
 */
export function buildBlockNoteSummaryBlocks(blocks: readonly unknown[]): SummaryBlock[] {
  const result: SummaryBlock[] = [];
  const walk = (list: readonly unknown[]) => {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const block = raw as BlockNoteBlockLike;
      if (typeof block.id === 'string') {
        result.push({ blockId: block.id, text: inlineContentText(block.content) });
      }
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  walk(blocks);
  return result;
}

interface LegacySectionLike {
  title?: unknown;
  blocks?: unknown;
}

/**
 * Flatten the legacy summary (a map of section key → { title, blocks }) into
 * searchable texts from each block's plain `content`. Entries that are not
 * sections (`MeetingName`, `_section_order`) carry no blocks and contribute
 * nothing — only block content is searchable, per the spec.
 */
export function buildLegacySummaryBlocks(summary: unknown): SummaryBlock[] {
  if (!summary || typeof summary !== 'object') return [];

  const result: SummaryBlock[] = [];
  for (const section of Object.values(summary as Record<string, LegacySectionLike>)) {
    if (!section || typeof section !== 'object' || !Array.isArray(section.blocks)) continue;
    for (const raw of section.blocks) {
      const block = raw as { id?: unknown; content?: unknown };
      if (typeof block?.id === 'string' && typeof block.content === 'string') {
        result.push({ blockId: block.id, text: block.content });
      }
    }
  }
  return result;
}
