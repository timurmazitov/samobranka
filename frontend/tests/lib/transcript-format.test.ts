import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  formatSpeakerDisplayLabel,
  formatTranscriptText,
  formatTranscriptTime,
  hasSpeakerLabels,
  normalizeTranscriptText,
  orderMeetingSpeakersForChip,
} from '../../src/lib/transcript-format';
import type { MeetingSpeaker, Transcript } from '../../src/types';

// The Rust repository's normalize_transcript_text is authoritative for the
// saved text; this TypeScript mirror keeps the optimistic row value equal to
// what the database will store. One shared fixture pins both sides (the Rust
// side reads the same file), mirroring how live-diarization.test.ts pins
// DIARIZATION_BAND_START against progress_scale.rs.
type NormalizeCase = { description: string; input: string; expected: string };
const normalizeCases: NormalizeCase[] = JSON.parse(
  readFileSync(
    new URL('../../src-tauri/tests/fixtures/transcript-normalize.json', import.meta.url),
    'utf8',
  ),
).cases;

describe('normalizeTranscriptText mirrors the Rust repository normalizer', () => {
  for (const testCase of normalizeCases) {
    test(testCase.description, () => {
      expect(normalizeTranscriptText(testCase.input)).toBe(testCase.expected);
    });
  }
});

function segment(overrides: Partial<Transcript> = {}): Transcript {
  return {
    id: '1',
    text: 'Всем привет.',
    timestamp: '14:30:05',
    audio_start_time: 0,
    audio_end_time: 24,
    ...overrides,
  };
}

describe('formatTranscriptTime', () => {
  test('formats seconds as MM:SS', () => {
    expect(formatTranscriptTime(0)).toBe('00:00');
    expect(formatTranscriptTime(24)).toBe('00:24');
    expect(formatTranscriptTime(75)).toBe('01:15');
  });

  test('undefined yields --:--', () => {
    expect(formatTranscriptTime(undefined)).toBe('--:--');
  });
});

describe('formatTranscriptText', () => {
  test('without speakers keeps the legacy [MM:SS] format', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', audio_start_time: 0, audio_end_time: 24 }),
      segment({ id: '2', text: 'Добрый день.', audio_start_time: 24, audio_end_time: 40 }),
    ]);
    expect(text).toBe('[00:00] Всем привет.\n[00:24] Добрый день.');
  });

  test('with speakers produces ranges and the assigned names', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', speaker: 'speaker_0', speaker_name: 'Alex' }),
      segment({
        id: '2',
        text: 'Добрый день.',
        audio_start_time: 24,
        audio_end_time: 40,
        speaker: 'speaker_1',
        speaker_name: 'Maria',
      }),
    ]);
    expect(text).toBe('[00:00–00:24] Alex: Всем привет.\n[00:24–00:40] Maria: Добрый день.');
  });

  test('without a name falls back to a 1-based Speaker N taken from the label suffix', () => {
    const text = formatTranscriptText([
      segment({ text: 'Добрый день.', speaker: 'speaker_1', audio_start_time: 24, audio_end_time: 40 }),
    ]);
    expect(text).toBe('[00:24–00:40] Speaker 2: Добрый день.');
  });

  test('segments without a label keep the range but omit the label', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', speaker: 'speaker_0', speaker_name: 'Alex' }),
      segment({ id: '2', text: 'Неразборчиво.', audio_start_time: 24, audio_end_time: 40 }),
    ]);
    expect(text).toBe('[00:00–00:24] Alex: Всем привет.\n[00:24–00:40] Неразборчиво.');
  });

  test('legacy mic/system/free-form speaker values keep the legacy format and get no prefix', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', speaker: 'mic' }),
      segment({ id: '2', text: 'Добрый день.', audio_start_time: 24, audio_end_time: 40, speaker: 'system' }),
      segment({ id: '3', text: 'Третий.', audio_start_time: 40, audio_end_time: 50, speaker: 'Guest A' }),
    ]);
    expect(text).toBe('[00:00] Всем привет.\n[00:24] Добрый день.\n[00:40] Третий.');
  });

  test('a name without a diarization label does not trigger the labelled format', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', speaker_name: 'Alex' }),
      segment({ id: '2', text: 'Добрый день.', audio_start_time: 24, audio_end_time: 40 }),
    ]);
    expect(text).toBe('[00:00] Всем привет.\n[00:24] Добрый день.');
  });

  test('a segment without audio_end_time falls back to a single timestamp', () => {
    const text = formatTranscriptText([
      segment({ text: 'Всем привет.', speaker: 'speaker_0', speaker_name: 'Alex', audio_end_time: undefined }),
    ]);
    expect(text).toBe('[00:00] Alex: Всем привет.');
  });

  test('a segment without audio_start_time uses the wall-clock fallback verbatim', () => {
    const text = formatTranscriptText(
      [segment({ audio_start_time: undefined, audio_end_time: undefined })],
      { fallbackTimestamp: t => t.timestamp },
    );
    expect(text).toBe('14:30:05 Всем привет.');
  });

  test('header is prepended and markdownLineBreaks adds two trailing spaces', () => {
    const text = formatTranscriptText(
      [segment({ text: 'Всем привет.', speaker: 'speaker_0', speaker_name: 'Alex' })],
      { header: '# Title\n\n', markdownLineBreaks: true },
    );
    expect(text).toBe('# Title\n\n[00:00–00:24] Alex: Всем привет.  ');
  });
});

describe('formatSpeakerDisplayLabel', () => {
  test('uses the assigned name as-is', () => {
    expect(formatSpeakerDisplayLabel('speaker_0', 'Alex')).toBe('Alex');
    expect(formatSpeakerDisplayLabel('speaker_0', 'Guest  A')).toBe('Guest  A');
  });

  test('an empty or whitespace-only name counts as absent', () => {
    expect(formatSpeakerDisplayLabel('speaker_0', '')).toBe('Speaker 1');
    expect(formatSpeakerDisplayLabel('speaker_0', '   ')).toBe('Speaker 1');
  });

  test('falls back to the 1-based number from the label, not from ordering', () => {
    expect(formatSpeakerDisplayLabel('speaker_0', undefined)).toBe('Speaker 1');
    expect(formatSpeakerDisplayLabel('speaker_7', undefined)).toBe('Speaker 8');
  });

  test('non-diarization values produce no label', () => {
    expect(formatSpeakerDisplayLabel('mic', 'Alex')).toBeNull();
    expect(formatSpeakerDisplayLabel('system', undefined)).toBeNull();
    expect(formatSpeakerDisplayLabel('Guest A', 'Guest A')).toBeNull();
    expect(formatSpeakerDisplayLabel(undefined, 'Alex')).toBeNull();
    expect(formatSpeakerDisplayLabel(undefined, undefined)).toBeNull();
  });
});

describe('hasSpeakerLabels', () => {
  test('is true when at least one segment carries a diarization label', () => {
    expect(hasSpeakerLabels([segment(), segment({ id: '2', speaker: 'speaker_3' })])).toBe(true);
  });

  test('is false without diarization labels, including legacy values and names alone', () => {
    expect(hasSpeakerLabels([segment()])).toBe(false);
    expect(hasSpeakerLabels([segment({ speaker: 'mic' }), segment({ id: '2', speaker: 'system' })])).toBe(false);
    expect(hasSpeakerLabels([segment({ speaker: 'Guest A' })])).toBe(false);
    expect(hasSpeakerLabels([segment({ speaker_name: 'Alex' })])).toBe(false);
  });
});

describe('orderMeetingSpeakersForChip', () => {
  const speaker = (
    label: string,
    speaker_name: string | null,
    first_start_time = 0,
  ): MeetingSpeaker => ({ label, speaker_name, segment_count: 1, first_start_time });

  test('named speakers come first, alphabetically by their visible label', () => {
    const ordered = orderMeetingSpeakersForChip([
      speaker('speaker_0', 'Zoe'),
      speaker('speaker_1', 'анна'),
      speaker('speaker_2', 'Alex'),
    ]);

    expect(ordered.map(item => item.speaker_name)).toEqual(['анна', 'Alex', 'Zoe']);
  });

  test('unnamed speakers follow, in label-number order rather than page order', () => {
    const ordered = orderMeetingSpeakersForChip([
      speaker('speaker_3', null, 0),
      speaker('speaker_1', null, 4),
      speaker('speaker_0', 'Alex', 9),
      speaker('speaker_2', null, 12),
    ]);

    expect(ordered.map(item => item.label)).toEqual([
      'speaker_0',
      'speaker_1',
      'speaker_2',
      'speaker_3',
    ]);
  });

  test('a blank name counts as absent, like everywhere else', () => {
    const ordered = orderMeetingSpeakersForChip([
      speaker('speaker_0', '   '),
      speaker('speaker_1', 'Alex'),
    ]);

    expect(ordered.map(item => item.label)).toEqual(['speaker_1', 'speaker_0']);
  });

  test('no database or page order changes the result', () => {
    const meeting = [
      speaker('speaker_2', null, 0),
      speaker('speaker_0', 'Zoe', 1),
      speaker('speaker_1', null, 2),
      speaker('speaker_3', 'Мария', 3),
    ];

    expect(orderMeetingSpeakersForChip(meeting).map(item => item.label)).toEqual(
      orderMeetingSpeakersForChip([...meeting].reverse()).map(item => item.label),
    );
  });

  test('the caller\'s array is not mutated', () => {
    const meeting = [speaker('speaker_1', null), speaker('speaker_0', 'Zoe')];
    const labels = meeting.map(item => item.label);

    orderMeetingSpeakersForChip(meeting);

    expect(meeting.map(item => item.label)).toEqual(labels);
  });

  test('a label that is not a diarization label is never treated as unnamed order', () => {
    // `mic` has no numeric suffix; the canonical regex must not guess one.
    const ordered = orderMeetingSpeakersForChip([speaker('mic', null), speaker('speaker_9', null)]);

    expect(ordered).toHaveLength(2);
    expect(ordered.every(item => ['mic', 'speaker_9'].includes(item.label))).toBe(true);
  });
});
