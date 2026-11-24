import { Transcript, MeetingSpeaker } from '@/types';
import { comparePersonNames } from '@/lib/person-sort';

/** Matches the only values the diarization pass writes (`speaker_0`, `speaker_1`, …). */
const DIARIZATION_LABEL = /^speaker_(\d+)$/;

/**
 * Format recording-relative seconds as MM:SS.
 */
export function formatTranscriptTime(seconds: number | undefined): string {
  if (seconds === undefined) return '--:--';
  const totalSecs = Math.floor(seconds);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Recording-relative seconds as a bracketed clock label, `[MM:SS]`
 * (`[--:--]` when absent) — the form the transcript rows render. The single
 * bracketed `[mm:ss]` formatter for the app; callers that need the bare
 * `MM:SS` (the recording status bar) use `formatTranscriptTime` directly.
 */
export function formatRecordingTime(seconds: number | undefined): string {
  return `[${formatTranscriptTime(seconds)}]`;
}

/**
 * Whether a speaker value is a diarization label (`speaker_N`).
 *
 * The legacy `speaker` column also documented `mic`/`system` audio-source
 * values, and free-form strings are not diarization labels either; neither
 * counts as a speaker (same rule as the transcript chip).
 */
export function isDiarizationSpeakerLabel(speaker: string | undefined): boolean {
  return speaker !== undefined && DIARIZATION_LABEL.test(speaker);
}

/**
 * Display label for a single segment's speaker: the assigned name, else
 * `Speaker N` (1-based, N taken from the `speaker_N` label suffix), else
 * `null` when the segment has no diarization label (no prefix at all).
 * The name is used verbatim; an empty or whitespace-only name counts as absent.
 */
export function formatSpeakerDisplayLabel(
  speaker: string | undefined,
  speakerName: string | undefined,
): string | null {
  if (!speaker) return null;
  const match = DIARIZATION_LABEL.exec(speaker);
  if (!match) return null;
  if (speakerName && speakerName.trim()) return speakerName;
  return `Speaker ${Number(match[1]) + 1}`;
}

/**
 * Whether any segment carries a diarization label. Only then do lines get the
 * `[MM:SS–MM:SS]` range and a speaker prefix; otherwise the legacy format is
 * kept byte-for-byte.
 *
 * Deliberate legacy decision: a transcript without diarization labels keeps
 * the old `[MM:SS] text` format unchanged. The legacy `speaker` column also
 * documented `mic`/`system` and stored free-form strings; those are audio
 * sources, not people, so they never produce a prefix or a time range. The
 * transcript chip, the Speakers panel and the per-row dropdown follow the same
 * rule (see `isDiarizationSpeakerLabel`).
 */
export function hasSpeakerLabels(transcripts: Transcript[]): boolean {
  return transcripts.some(t => isDiarizationSpeakerLabel(t.speaker));
}

/** Display label for a meeting speaker: the name, else `Speaker N`, else the raw label. */
function meetingSpeakerDisplayLabel(speaker: MeetingSpeaker): string {
  return formatSpeakerDisplayLabel(speaker.label, speaker.speaker_name ?? undefined) ?? speaker.label;
}

/**
 * Whether the speaker already carries a person's name. An empty or
 * whitespace-only name counts as absent, the same rule as
 * `formatSpeakerDisplayLabel`.
 */
function hasPersonName(speaker: MeetingSpeaker): boolean {
  return !!speaker.speaker_name && speaker.speaker_name.trim().length > 0;
}

/**
 * Numeric suffix of a diarization label; unnamed speakers are ordered by it.
 * Only the canonical `speaker_N` shape yields a number, so a legacy value such
 * as `mic` never pretends to have one.
 */
function labelNumber(label: string): number {
  const match = DIARIZATION_LABEL.exec(label);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/**
 * The order of the transcript chip's speaker dropdown.
 *
 * Named speakers come first, sorted by the shared people comparator on the
 * label the user actually sees; unnamed ones (`Speaker 1`, `Speaker 2`, …)
 * follow in label-number order rather than in page order, so the list is the
 * same whatever page of the transcript happens to be loaded. "No speaker" is
 * rendered outside this list and stays last. The caller's array is copied, not
 * sorted in place: the panel's rows keep their first-appearance order.
 *
 * This lives here, not in `person-sort.ts`: that comparator deliberately knows
 * nothing about meetings or about "unnamed" speakers.
 */
export function orderMeetingSpeakersForChip(speakers: MeetingSpeaker[]): MeetingSpeaker[] {
  return [...speakers].sort((a, b) => {
    const aNamed = hasPersonName(a);
    const bNamed = hasPersonName(b);
    if (aNamed !== bNamed) return aNamed ? -1 : 1;
    if (aNamed) {
      return comparePersonNames(
        meetingSpeakerDisplayLabel(a),
        meetingSpeakerDisplayLabel(b),
      );
    }
    const byNumber = labelNumber(a.label) - labelNumber(b.label);
    if (byNumber !== 0) return byNumber;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

export interface FormatTranscriptOptions {
  /** Prepended verbatim to the formatted text (e.g. a markdown header). */
  header?: string;
  /**
   * Fallback for old transcripts without audio_start_time. The returned label
   * is used verbatim, without brackets (legacy meeting-details copy behavior).
   */
  fallbackTimestamp?: (transcript: Transcript) => string;
  /** Append two trailing spaces to each line (markdown line break, legacy). */
  markdownLineBreaks?: boolean;
}

/**
 * Format transcript segments as plain text, one line per segment.
 *
 * When any segment carries a diarization speaker label, every line includes a
 * `[MM:SS–MM:SS]` time range and a speaker prefix — the assigned name, else
 * `Speaker N`. Lines without a label keep the range but omit the prefix. When
 * no segment has a diarization label, lines keep the legacy `[MM:SS]` format.
 * A segment without audio_end_time falls back to a single `[MM:SS]` label.
 */
export function formatTranscriptText(
  transcripts: Transcript[],
  options: FormatTranscriptOptions = {},
): string {
  const hasSpeakers = hasSpeakerLabels(transcripts);
  const suffix = options.markdownLineBreaks ? '  ' : '';

  const lines = transcripts.map(t => {
    let prefix: string;
    if (t.audio_start_time === undefined) {
      prefix = options.fallbackTimestamp ? options.fallbackTimestamp(t) : '[--:--]';
    } else {
      const start = formatTranscriptTime(t.audio_start_time);
      const timeLabel = hasSpeakers && t.audio_end_time !== undefined
        ? `${start}–${formatTranscriptTime(t.audio_end_time)}`
        : start;
      prefix = `[${timeLabel}]`;
    }
    const displayLabel = hasSpeakers ? formatSpeakerDisplayLabel(t.speaker, t.speaker_name) : null;
    const speakerLabel = displayLabel ? `${displayLabel}: ` : '';
    return `${prefix} ${speakerLabel}${t.text}${suffix}`;
  });

  return (options.header ?? '') + lines.join('\n');
}

/**
 * The single-line form of an edited transcript text: every whitespace run
 * (newlines and tabs from pastes included) collapses to one space and the
 * ends trim. This mirrors the Rust `normalize_transcript_text` in the
 * transcript repository — the repository stays authoritative, and both the
 * row and the pagination hook normalize through this one function so the
 * optimistic value equals what the database will store. The shared fixture
 * `src-tauri/tests/fixtures/transcript-normalize.json` pins both sides.
 * Whitespace means Unicode White_Space (Rust `char::is_whitespace`), NOT
 * JS `/\s/`: that would split U+FEFF (kept by Rust) and keep U+0085 (split
 * by Rust).
 */
export function normalizeTranscriptText(text: string): string {
  return text
    .split(/[\p{White_Space}]+/u)
    .filter(part => part.length > 0)
    .join(' ');
}
