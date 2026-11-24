/**
 * The single matching rule for the meeting find & replace panel: given one
 * text (a transcript segment or a summary block) and a query, it returns the
 * ordered, non-overlapping `[from, to)` ranges where the query occurs. The
 * ranges are UTF-16 indices into the original text — `text.slice(from, to)`
 * is exactly the matched text — so highlighting and replacing are plain
 * string operations and never disagree with this function.
 *
 * Modes: case-insensitive substring search by default; `caseSensitive` and
 * `wholeWord` are opt-in toggles, independent of each other. "Whole word"
 * uses Unicode letter/digit boundary checks, not the regex `\b`: `\b` and
 * `\w` are ASCII-only and would let «мор» match inside «мотор». A match only
 * counts when neither neighbour character is a letter or a digit (any script),
 * so punctuation, whitespace and the text edges delimit words on both sides.
 *
 * After a match the scan resumes at its end, so overlapping occurrences are
 * never both reported («аа» in «ааа» gives one range) while adjacent ones are
 * («а» in «аха» gives two). An empty or whitespace-only query never matches;
 * a query containing inner whitespace matches literally.
 */

export interface MatchRange {
  from: number;
  to: number;
}

/**
 * Splice one matched range out of the text it was found in: the text before
 * `range.from`, the replacement, then the text after `range.to`. `from`/`to`
 * are UTF-16 indices into exactly this string (the same source `findMatches`
 * scanned), so the edit is a plain slice — `replacement` may be '' for a
 * deletion, exactly like replacing with an empty string in an editor. The one
 * splice rule for both find & replace sides: the transcript's segment saves
 * and the legacy summary's plain-content replacements.
 */
export function spliceMatchRange(text: string, range: MatchRange, replacement: string): string {
  return text.slice(0, range.from) + replacement + text.slice(range.to);
}

export interface FindMatchesOptions {
  /** Match the query's exact spelling. Default: case-insensitive. */
  caseSensitive?: boolean;
  /** Only match the query as a whole word. Default: substring. */
  wholeWord?: boolean;
}

/**
 * The character class a whole-word match may not touch: letters and digits of
 * any script. Underscore and combining marks deliberately do not count — a
 * match next to them still reads as a standalone word.
 */
function isWordCharacter(character: string): boolean {
  return /[0-9\p{L}]/u.test(character);
}

/**
 * The text scanned as one code point at a time: indices are UTF-16 offsets,
 * but comparisons — case folding and the neighbour checks — must not split a
 * surrogate pair, so each entry knows its end offset.
 */
interface CodePointAt {
  character: string;
  end: number;
}

function codePoints(text: string): CodePointAt[] {
  const points: CodePointAt[] = [];
  for (const character of text) {
    points.push({ character, end: points.length === 0 ? character.length : points[points.length - 1].end + character.length });
  }
  return points;
}

export function findMatches(text: string, query: string, options: FindMatchesOptions = {}): MatchRange[] {
  if (!query.trim() || query.length > text.length) {
    return [];
  }

  const { caseSensitive = false, wholeWord = false } = options;
  const fold = (character: string) => (caseSensitive ? character : character.toLowerCase());

  const haystack = codePoints(text);
  const needle = codePoints(query);
  const matches: MatchRange[] = [];

  // `point` walks the code points; a candidate at `needleStart` matches when
  // every needle code point equals the haystack's at the same step. The last
  // matched code point records where the range ends in UTF-16 indices.
  let point = 0;
  while (point < haystack.length) {
    let step = 0;
    while (
      step < needle.length &&
      point + step < haystack.length &&
      fold(haystack[point + step].character) === fold(needle[step].character)
    ) {
      step += 1;
    }

    if (step < needle.length) {
      point += 1;
      continue;
    }

    const from = haystack[point].end - haystack[point].character.length;
    const to = haystack[point + needle.length - 1].end;
    const before = point > 0 ? haystack[point - 1].character : '';
    const after = point + needle.length < haystack.length ? haystack[point + needle.length].character : '';

    if (wholeWord && (isWordCharacter(before) || isWordCharacter(after))) {
      // Not a whole word: the candidate's first code point cannot start one
      // either, so resume after it — the next candidate is the next code point.
      point += 1;
      continue;
    }

    matches.push({ from, to });
    point += needle.length;
  }

  return matches;
}
