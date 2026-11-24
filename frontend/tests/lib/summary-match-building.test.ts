import { describe, expect, test } from 'bun:test';

import {
  buildBlockNoteSummaryBlocks,
  buildLegacySummaryBlocks,
  buildSummaryMatches,
} from '../../src/hooks/meeting-details/useFindReplace';

/**
 * The summary match contract, pinned independently of any editor: matches are
 * found inside one text block at a time (never across blocks — the spec's
 * boundary rule), keyed by the editor block id, with UTF-16 ranges into that
 * block's concatenated text. The block text for BlockNote is composed from the
 * inline content — plain styled text plus link text — so the ranges line up
 * with what the editor shows.
 */
describe('buildSummaryMatches', () => {
  const blocks = [
    { blockId: 'b1', text: 'Alpha beta' },
    { blockId: 'b2', text: 'beta again, beta' },
  ];

  test('one match per occurrence in display order with block-keyed ranges', () => {
    expect(buildSummaryMatches(blocks, 'beta', {})).toEqual([
      { key: 'summary:b1:0', source: 'summary', blockId: 'b1', from: 6, to: 10 },
      { key: 'summary:b2:0', source: 'summary', blockId: 'b2', from: 0, to: 4 },
      { key: 'summary:b2:1', source: 'summary', blockId: 'b2', from: 12, to: 16 },
    ]);
  });

  test('the case and whole-word toggles apply to summary blocks too', () => {
    const cyrillic = [{ blockId: 'b1', text: 'Бета бета мотор' }];

    expect(buildSummaryMatches(cyrillic, 'бета', {}).map(m => m.from)).toEqual([0, 5]);
    expect(buildSummaryMatches(cyrillic, 'бета', { caseSensitive: true }).map(m => m.from)).toEqual([5]);
    expect(buildSummaryMatches(cyrillic, 'мот', { wholeWord: true })).toEqual([]);
    expect(buildSummaryMatches(cyrillic, 'мот', {}).map(m => m.from)).toEqual([10]);
  });

  test('an empty or whitespace query matches nothing', () => {
    expect(buildSummaryMatches(blocks, '', {})).toEqual([]);
    expect(buildSummaryMatches(blocks, '   ', {})).toEqual([]);
  });
});

describe('buildBlockNoteSummaryBlocks', () => {
  const text = (t: string, styles: Record<string, boolean> = {}) => ({
    type: 'text',
    text: t,
    styles,
  });

  test('concatenates styled text runs in order', () => {
    const blocks = buildBlockNoteSummaryBlocks([
      { id: 'b1', type: 'paragraph', content: [text('Hello '), text('world', { bold: true })] },
    ] as never);
    expect(blocks).toEqual([{ blockId: 'b1', text: 'Hello world' }]);
  });

  test('includes link text in the block text', () => {
    const blocks = buildBlockNoteSummaryBlocks([
      {
        id: 'b1',
        type: 'paragraph',
        content: [
          text('see '),
          { type: 'link', content: [text('the docs', { underline: true })] },
        ],
      },
    ] as never);
    expect(blocks).toEqual([{ blockId: 'b1', text: 'see the docs' }]);
  });

  test('walks nested blocks in document order', () => {
    const blocks = buildBlockNoteSummaryBlocks([
      {
        id: 'outer',
        type: 'paragraph',
        content: [text('outer text')],
        children: [
          { id: 'nested', type: 'bulletListItem', content: [text('nested text')] },
        ],
      },
    ] as never);
    expect(blocks).toEqual([
      { blockId: 'outer', text: 'outer text' },
      { blockId: 'nested', text: 'nested text' },
    ]);
  });

  test('a match inside one run never spans blocks', () => {
    // The query straddles two blocks' texts but matches inside neither —
    // the boundary rule the match builder inherits from findMatches.
    const blocks = buildBlockNoteSummaryBlocks([
      { id: 'b1', type: 'paragraph', content: [text('al')] },
      { id: 'b2', type: 'paragraph', content: [text('pha')] },
    ] as never);
    expect(buildSummaryMatches(blocks, 'alpha', {})).toEqual([]);
  });

  test('empty blocks contribute empty text', () => {
    const blocks = buildBlockNoteSummaryBlocks([
      { id: 'b1', type: 'paragraph' },
      { id: 'b2', type: 'paragraph', content: [] },
    ] as never);
    expect(blocks).toEqual([
      { blockId: 'b1', text: '' },
      { blockId: 'b2', text: '' },
    ]);
  });
});

describe('buildLegacySummaryBlocks', () => {
  test('walks sections in key order and blocks in array order', () => {
    const summary = {
      overview: {
        title: 'Overview',
        blocks: [
          { id: 'o-1', type: 'heading1', content: 'Key decisions', color: 'default' },
          { id: 'o-2', type: 'bullet', content: 'Ship alpha release', color: 'default' },
        ],
      },
      actions: {
        title: 'Action items',
        blocks: [{ id: 'a-1', type: 'text', content: 'alpha owner unknown', color: 'default' }],
      },
    };

    expect(buildLegacySummaryBlocks(summary as never)).toEqual([
      { blockId: 'o-1', text: 'Key decisions' },
      { blockId: 'o-2', text: 'Ship alpha release' },
      { blockId: 'a-1', text: 'alpha owner unknown' },
    ]);
  });

  test('non-section entries (MeetingName, _section_order) never contribute text', () => {
    const summary = {
      MeetingName: 'alpha standup',
      _section_order: ['overview'],
      overview: {
        title: 'Overview',
        blocks: [{ id: 'o-1', type: 'text', content: 'plain block', color: 'default' }],
      },
    };

    expect(buildLegacySummaryBlocks(summary as never)).toEqual([
      { blockId: 'o-1', text: 'plain block' },
    ]);
    // …and «alpha», which exists only in the excluded MeetingName, finds nothing.
    expect(buildSummaryMatches(buildLegacySummaryBlocks(summary as never), 'alpha', {})).toEqual([]);
  });
});
