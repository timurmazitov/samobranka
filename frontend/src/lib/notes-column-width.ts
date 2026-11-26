// Notes-column width preference (spec: notes-column, ticket 04). The width
// the user drags the column's resize handle to is remembered globally — one
// value for the whole app — and read back as the initial width on launch.
// The key follows the meeting-details preferences' dotted namespace. A
// stored value is honored only when it parses to a finite number and is
// clamped into the bounds; anything else falls back to the default
// like a missing value.
//
// Review update: the upper bound is dynamic — at most half the current
// window width, so the list can be widened to half the screen. When the
// viewport width is unknown (SSR, tests), the clamp falls back to the
// previous fixed bound so non-browser renders behave like before.

export const NOTES_COLUMN_WIDTH_KEY = 'samobranka.notesColumn.width';

export const NOTES_COLUMN_MIN_WIDTH = 240;
/** The cap for viewports whose width cannot be read (SSR, tests). */
export const FALLBACK_NOTES_COLUMN_MAX_WIDTH = 480;
export const NOTES_COLUMN_MAX_WIDTH_RATIO = 0.5;
export const DEFAULT_NOTES_COLUMN_WIDTH = 320;

/**
 * The widest the column may be on a viewport of the given width: half the
 * window, never below the minimum. An unknown or unusable viewport falls
 * back to the fixed pre-review bound.
 */
export function maxNotesColumnWidth(viewportWidth?: number): number {
  const width = viewportWidth
    ?? (typeof window !== 'undefined' ? window.innerWidth : undefined);
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) {
    return FALLBACK_NOTES_COLUMN_MAX_WIDTH;
  }
  return Math.max(NOTES_COLUMN_MIN_WIDTH, Math.floor(width * NOTES_COLUMN_MAX_WIDTH_RATIO));
}

export function clampNotesColumnWidth(px: number, viewportWidth?: number): number {
  return Math.min(maxNotesColumnWidth(viewportWidth), Math.max(NOTES_COLUMN_MIN_WIDTH, px));
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
