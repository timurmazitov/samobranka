import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';

import { buildExportFileName, ensureFileExtension } from '../../src/lib/export-file';

const localDate = (year: number, month: number, day: number, hour = 12) =>
  new Date(year, month - 1, day, hour);

// Strip the date prefix, suffix and extension so a test can assert on the
// normalized meeting title alone.
function titlePart(fileName: string, suffix: string, extension: string): string {
  const withoutDate = fileName.replace(/^\d{8}-/, '');
  return withoutDate.replace(new RegExp(`-${suffix}\\.${extension}$`), '');
}

describe('buildExportFileName', () => {
  afterEach(() => {
    setSystemTime();
  });

  test('builds YYYYMMDD-title-transcript.md from the meeting date', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Release planning',
      kind: 'transcript',
    })).toBe('20261118-Release_planning-transcript.md');
  });

  test('supports the summary suffix and extension', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Планёрка по релизу',
      kind: 'summary',
    })).toBe('20261118-Планёрка_по_релизу-summary.md');
  });

  test('takes the date from the local calendar day, not from UTC', () => {
    expect(buildExportFileName({
      date: localDate(2026, 1, 2, 23),
      title: 'Late meeting',
      kind: 'transcript',
    })).toBe('20260102-Late_meeting-transcript.md');
  });

  test('accepts a timestamp-string meeting date', () => {
    const recordedAt = localDate(2026, 9, 1, 9).toISOString();
    expect(buildExportFileName({
      date: recordedAt,
      title: 'Kickoff',
      kind: 'transcript',
    })).toBe('20260901-Kickoff-transcript.md');
  });

  test('accepts a date-only meeting date as that local day', () => {
    expect(buildExportFileName({
      date: '2026-09-01',
      title: 'Kickoff',
      kind: 'transcript',
    })).toBe('20260901-Kickoff-transcript.md');
  });

  test('accepts a meeting date in the RFC3339 form the backend sends', () => {
    // `recorded_at` reaches the frontend as Rust's `DateTimeUtc` rendering —
    // `+00:00`, not `Z` — so the offset form must name the local day too.
    const recordedAt = localDate(2026, 9, 1, 9).toISOString().replace('Z', '+00:00');
    expect(recordedAt).toEndWith('+00:00');

    expect(buildExportFileName({
      date: recordedAt,
      title: 'Kickoff',
      kind: 'summary',
    })).toBe('20260901-Kickoff-summary.md');
  });

  test('falls back to the current moment for a missing or invalid date', () => {
    setSystemTime(localDate(2026, 11, 18, 10));

    for (const date of [null, undefined, '', 'not-a-date']) {
      expect(buildExportFileName({
        date,
        title: 'Release planning',
        kind: 'transcript',
      })).toBe('20261118-Release_planning-transcript.md');
    }
  });

  test('falls back to the current moment for calendar days that do not exist', () => {
    setSystemTime(localDate(2026, 11, 18, 10));

    // `new Date(2026, 1, 31)` silently rolls over to March 3, so these must be
    // rejected instead of naming a day the meeting never happened on.
    for (const date of ['2026-02-31', '2026-13-01', '2026-00-10']) {
      expect(buildExportFileName({
        date,
        title: 'Release planning',
        kind: 'transcript',
      })).toBe('20261118-Release_planning-transcript.md');
    }
  });

  test('keeps Cyrillic and letter case readable', () => {
    expect(titlePart(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Планёрка Продукта',
      kind: 'transcript',
    }), 'transcript', 'md')).toBe('Планёрка_Продукта');
  });

  test('turns spaces into single underscores', () => {
    expect(titlePart(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: '  Release    planning   meeting  ',
      kind: 'transcript',
    }), 'transcript', 'md')).toBe('Release_planning_meeting');
  });

  test('replaces characters that file systems reject', () => {
    const fileName = buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'a/b\\c:d*e?f"g<h>i|j',
      kind: 'transcript',
    });

    expect(titlePart(fileName, 'transcript', 'md')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(fileName).not.toMatch(/[\\/:*?"<>|]/);
  });

  test('replaces newlines and tabs without leaving empty stretches', () => {
    expect(titlePart(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Line one\nLine\ttwo\r\n\r\nLine three',
      kind: 'transcript',
    }), 'transcript', 'md')).toBe('Line_one_Line_two_Line_three');
  });

  test('collapses repeated and edge underscores', () => {
    expect(titlePart(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: '___Release // planning ___',
      kind: 'transcript',
    }), 'transcript', 'md')).toBe('Release_planning');
  });

  test('truncates a long Cyrillic title to 60 characters', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Очень длинное название встречи про планирование релиза номер один',
      kind: 'transcript',
    })).toBe(
      '20261118-Очень_длинное_название_встречи_про_планирование_релиза_номер-transcript.md',
    );
  });

  test('truncates by character boundary, keeping surrogate pairs intact', () => {
    const fileName = buildExportFileName({
      date: localDate(2026, 11, 18),
      title: `a${'😀'.repeat(70)}`,
      kind: 'transcript',
    });

    expect(titlePart(fileName, 'transcript', 'md')).toBe(`a${'😀'.repeat(59)}`);
    expect(fileName.isWellFormed()).toBe(true);
  });

  test('does not end a truncated title with an underscore', () => {
    expect(titlePart(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'слово '.repeat(12),
      kind: 'transcript',
    }), 'transcript', 'md')).toBe(
      'слово_слово_слово_слово_слово_слово_слово_слово_слово_слово',
    );
  });

  test('falls back to meeting for an empty or blank title', () => {
    for (const title of ['', '   ', '\n\t', null, undefined]) {
      expect(buildExportFileName({
        date: localDate(2026, 11, 18),
        title,
        kind: 'transcript',
      })).toBe('20261118-meeting-transcript.md');
    }
  });

  test('falls back to meeting for a title made only of separators', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: ' /// ',
      kind: 'transcript',
    })).toBe('20261118-meeting-transcript.md');
  });

  test('falls back to meeting for the new-call placeholder title', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: '+ New Call',
      kind: 'transcript',
    })).toBe('20261118-meeting-transcript.md');
  });

  test('keeps the dot in a title and still appends the extension', () => {
    expect(buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Release v1.2 plan',
      kind: 'summary',
    })).toBe('20261118-Release_v1.2_plan-summary.md');
  });

  test('never produces characters that file systems reject', () => {
    const fileName = buildExportFileName({
      date: localDate(2026, 11, 18),
      title: 'Bad / name \\ with : everything * ? " < > | here',
      kind: 'transcript',
    });

    expect(fileName).not.toMatch(/[\\/:*?"<>|]/);
    expect(fileName).not.toMatch(/[\n\r\t]/);
    expect(fileName).toMatch(/^\d{8}-[^-]+-transcript\.md$/u);
  });
});

describe('ensureFileExtension', () => {
  test('appends the extension when the name has none', () => {
    expect(ensureFileExtension('20261118-Release_planning-transcript', 'md'))
      .toBe('20261118-Release_planning-transcript.md');
  });

  test('accepts an extension written with a leading dot', () => {
    expect(ensureFileExtension('20261118-Release_planning-summary', '.md'))
      .toBe('20261118-Release_planning-summary.md');
  });

  test('keeps an extension the name already has', () => {
    expect(ensureFileExtension('20261118-Release_planning-transcript.md', 'md'))
      .toBe('20261118-Release_planning-transcript.md');
  });

  test('does not replace an extension the user typed', () => {
    expect(ensureFileExtension('20261118-Release_planning-summary.markdown', 'md'))
      .toBe('20261118-Release_planning-summary.markdown');
  });

  test('keeps an existing extension written in capitals', () => {
    expect(ensureFileExtension('20261118-Release_planning-summary.MD', 'md'))
      .toBe('20261118-Release_planning-summary.MD');
  });

  test('is a no-op for an empty extension', () => {
    expect(ensureFileExtension('20261118-Release_planning-transcript', ''))
      .toBe('20261118-Release_planning-transcript');
  });

  test('appends the extension instead of keeping a bare trailing dot', () => {
    // Rust's `Path::with_extension` turns `plan.` into `plan.md`; both sides
    // must agree so the file the dialog shows is the file that gets written.
    expect(ensureFileExtension('20261118-plan-summary.', 'md'))
      .toBe('20261118-plan-summary.md');
  });

  test('keeps a short dotted suffix the user typed', () => {
    expect(ensureFileExtension('20261118-plan-summary.v2', 'md'))
      .toBe('20261118-plan-summary.v2');
  });

  test('keeps a long extension the user typed', () => {
    expect(ensureFileExtension('20261118-plan-summary.verylongextension', 'md'))
      .toBe('20261118-plan-summary.verylongextension');
  });

  test('does not mistake a dot inside the title for an extension', () => {
    // A normalized title may contain dots (`Release_v1.2`). The text after the
    // latest dot is not a file extension there, so `md` must still be appended.
    expect(ensureFileExtension('20261118-Release_v1.2-summary', 'md'))
      .toBe('20261118-Release_v1.2-summary.md');
  });

  test('treats a leading-dot name as having no extension, like Rust', () => {
    // `Path::extension()` is None for `.hidden`, so Rust writes `.hidden.md`.
    expect(ensureFileExtension('.hidden', 'md')).toBe('.hidden.md');
  });
});
