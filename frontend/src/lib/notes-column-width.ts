// Notes-column width preference (spec: notes-column, ticket 04). The width
// the user drags the column's resize handle to is remembered globally — one
// value for the whole app — and read back as the initial width on launch.
// The key follows the meeting-details preferences' dotted namespace. A
// stored value is honored only when it parses to a finite number and is
// clamped into the spec bounds; anything else falls back to the default
// like a missing value.

export const NOTES_COLUMN_WIDTH_KEY = 'samobranka.notesColumn.width';

export const NOTES_COLUMN_MIN_WIDTH = 240;
export const NOTES_COLUMN_MAX_WIDTH = 480;
export const DEFAULT_NOTES_COLUMN_WIDTH = 320;

export function clampNotesColumnWidth(px: number): number {
  return Math.min(NOTES_COLUMN_MAX_WIDTH, Math.max(NOTES_COLUMN_MIN_WIDTH, px));
}

export function readNotesColumnWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_NOTES_COLUMN_WIDTH;
  try {
    const value = window.localStorage.getItem(NOTES_COLUMN_WIDTH_KEY);
    if (value === null) return DEFAULT_NOTES_COLUMN_WIDTH;
    const width = Number.parseInt(value, 10);
    if (!Number.isFinite(width)) return DEFAULT_NOTES_COLUMN_WIDTH;
    return clampNotesColumnWidth(width);
  } catch {
    return DEFAULT_NOTES_COLUMN_WIDTH;
  }
}

export function writeNotesColumnWidth(px: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(NOTES_COLUMN_WIDTH_KEY, String(px));
  } catch {
    // Preference writes are non-critical; the width still applies for the session.
  }
}
