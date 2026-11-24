import { describe, expect, test } from 'bun:test';

import { findMatches } from '../../src/lib/find-matches';

/**
 * The find & replace contract, pinned independently of any UI: `findMatches`
 * returns ordered, non-overlapping `[from, to)` ranges of UTF-16 indices where
 * the query occurs in the text — `text.slice(from, to)` is always the matched
 * text, so callers can highlight and replace with plain string operations.
 * Default mode is a case-insensitive substring; `caseSensitive` and
 * `wholeWord` are opt-in toggles. An empty or whitespace-only query finds
 * nothing; a query with inner whitespace matches literally.
 */
const ranges = (text: string, query: string, options = {}) =>
  findMatches(text, query, options).map((m) => text.slice(m.from, m.to));

describe('findMatches', () => {
  test('finds a substring ignoring case by default', () => {
    expect(findMatches('Мороз и солнце', 'МОРОЗ')).toEqual([{ from: 0, to: 5 }]);
    expect(findMatches('Hello world, hello again', 'HELLO')).toEqual([
      { from: 0, to: 5 },
      { from: 13, to: 18 },
    ]);
  });

  test('caseSensitive off still finds every case variant', () => {
    expect(ranges('aA b Aa', 'aa')).toEqual(['aA', 'Aa']);
  });

  test('caseSensitive on only finds the exact spelling', () => {
    expect(findMatches('Hello hello HELLO', 'hello', { caseSensitive: true })).toEqual([
      { from: 6, to: 11 },
    ]);
  });

  test('wholeWord keeps a Cyrillic word out of a longer word', () => {
    // «мор» must not light up inside «мотор» or the inflected «мором»,
    // which differ from a standalone word only by adjacent letters.
    expect(findMatches('мотор', 'мор', { wholeWord: true })).toEqual([]);
    expect(findMatches('мором', 'мор', { wholeWord: true })).toEqual([]);
    expect(findMatches('мотор мором', 'мор', { wholeWord: true })).toEqual([]);
  });

  test('wholeWord finds the standalone Cyrillic word and inflects-out only without the toggle', () => {
    expect(findMatches('мор реке', 'мор', { wholeWord: true })).toEqual([{ from: 0, to: 3 }]);
    expect(findMatches('мором', 'мор')).toEqual([{ from: 0, to: 3 }]);
    // With the toggle the inflection is not the query anymore.
    expect(findMatches('мором мор', 'мор', { wholeWord: true })).toEqual([{ from: 6, to: 9 }]);
  });

  test('wholeWord boundary is punctuation-aware, digits glue', () => {
    expect(findMatches('«мор», «мотор»', 'мор', { wholeWord: true })).toEqual([{ from: 1, to: 4 }]);
    // A digit on either side makes it part of a bigger token, not a word.
    expect(findMatches('мор1 мор', 'мор', { wholeWord: true })).toEqual([{ from: 5, to: 8 }]);
  });

  test('wholeWord keeps a Latin word out of a longer word', () => {
    expect(findMatches('cat catalog scat', 'cat', { wholeWord: true })).toEqual([{ from: 0, to: 3 }]);
  });

  test('empty and whitespace-only queries find nothing', () => {
    expect(findMatches('что угодно', '')).toEqual([]);
    expect(findMatches('что угодно', '   \t\n ')).toEqual([]);
  });

  test('a query with inner whitespace matches literally', () => {
    expect(findMatches('привет мир, привет мир', 'привет мир')).toEqual([
      { from: 0, to: 10 },
      { from: 12, to: 22 },
    ]);
  });

  test('overlapping occurrences never overlap: the scan resumes after a match ends', () => {
    // «аа» at 0-2 wins; the occurrence starting at index 1 overlaps it and is
    // skipped; the scan resumes at 2 and finds 2-4.
    expect(findMatches('аааа', 'аа')).toEqual([
      { from: 0, to: 2 },
      { from: 2, to: 4 },
    ]);
    expect(findMatches('ааа', 'аа')).toEqual([{ from: 0, to: 2 }]);
  });

  test('adjacent occurrences are both found', () => {
    expect(findMatches('аха', 'а')).toEqual([
      { from: 0, to: 1 },
      { from: 2, to: 3 },
    ]);
  });

  test('a query longer than the text finds nothing', () => {
    expect(findMatches('кот', 'котик')).toEqual([]);
  });

  test('caseSensitive and wholeWord combine', () => {
    expect(findMatches('Мор мотор мор Мор', 'Мор', { caseSensitive: true, wholeWord: true })).toEqual([
      { from: 0, to: 3 },
      { from: 14, to: 17 },
    ]);
  });

  test('folding is case only: ё and е stay distinct letters', () => {
    // Pinned on purpose: the spec asks for a case toggle, not ё/е folding.
    // «Ёлка» matches «ёлка» (same letters, different case) but «елка» does
    // not match «ЁЛКА».
    expect(findMatches('Ёлка в лесу', 'ёлка')).toEqual([{ from: 0, to: 4 }]);
    expect(findMatches('ищем елка', 'ЁЛКА')).toEqual([]);
  });

  test('surrogate pairs are matched and ranged as whole characters', () => {
    // «😀» is two UTF-16 units; the range must span both, never split them.
    expect(findMatches('а😀б😀', '😀')).toEqual([
      { from: 1, to: 3 },
      { from: 4, to: 6 },
    ]);
  });

  test('results come out ordered by position', () => {
    const matches = findMatches('кошка кошка кошка', 'кошка');
    expect(matches).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
    const positions = matches.map((m) => m.from);
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
  });
});
