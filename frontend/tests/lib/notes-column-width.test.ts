/**
 * Notes-column width persistence (spec `.scratch/notes-column`, ticket 04 +
 * review update) — seam 3 from the spec's Testing Decisions: the clamp
 * helper and the localStorage read/write behind the column's resize handle.
 * The lower bound (240px), the default (320px) and the
 * `samobranka.notesColumn.width` key are fixed by the spec. The upper bound
 * is dynamic: at most half the current viewport width, with the previous
 * fixed 480px bound as the fallback when the viewport width is unknown.
 * A stored value is honored only when it parses to a finite number, and it
 * is clamped into the bounds; a corrupted or out-of-range entry falls back
 * like a missing one.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_NOTES_COLUMN_WIDTH,
  FALLBACK_NOTES_COLUMN_MAX_WIDTH,
  NOTES_COLUMN_MIN_WIDTH,
  NOTES_COLUMN_WIDTH_KEY,
  clampNotesColumnWidth,
  maxNotesColumnWidth,
  readNotesColumnWidth,
  writeNotesColumnWidth,
} from '../../src/lib/notes-column-width';

const stored = new Map<string, string>();
const workingStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function stubWindow(win: unknown = { localStorage: workingStorage }) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: win,
  });
}

function unstubWindow() {
  Reflect.deleteProperty(globalThis, 'window');
}

afterEach(() => {
  stored.clear();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('the width contract', () => {
  test('the minimum, the default, the fallback maximum and the storage key are the spec values', () => {
    expect(NOTES_COLUMN_MIN_WIDTH).toBe(240);
    expect(DEFAULT_NOTES_COLUMN_WIDTH).toBe(320);
    expect(FALLBACK_NOTES_COLUMN_MAX_WIDTH).toBe(480);
    expect(NOTES_COLUMN_WIDTH_KEY).toBe('samobranka.notesColumn.width');
  });
});

describe('maxNotesColumnWidth', () => {
  test('half the viewport width is the maximum', () => {
    expect(maxNotesColumnWidth(1280)).toBe(640);
    expect(maxNotesColumnWidth(1000)).toBe(500);
  });

  test('the minimum wins over a narrow viewport', () => {
    expect(maxNotesColumnWidth(400)).toBe(240);
  });

  test('an explicit zero or non-finite viewport falls back to the fixed bound', () => {
    expect(maxNotesColumnWidth(0)).toBe(FALLBACK_NOTES_COLUMN_MAX_WIDTH);
    expect(maxNotesColumnWidth(Number.NaN)).toBe(FALLBACK_NOTES_COLUMN_MAX_WIDTH);
  });

  test('without a viewport argument the current window width is used', () => {
    stubWindow({ localStorage: workingStorage, innerWidth: 1200 });
    expect(maxNotesColumnWidth()).toBe(600);
  });

  test('without any usable window there is the fixed fallback', () => {
    unstubWindow();
    expect(maxNotesColumnWidth()).toBe(FALLBACK_NOTES_COLUMN_MAX_WIDTH);
  });
});

describe('clampNotesColumnWidth', () => {
  test('a width below the minimum rises to 240', () => {
    expect(clampNotesColumnWidth(239, 1280)).toBe(240);
  });

  test('the minimum itself passes through', () => {
    expect(clampNotesColumnWidth(240, 1280)).toBe(240);
  });

  test('half the viewport is the maximum', () => {
    expect(clampNotesColumnWidth(700, 1280)).toBe(640);
    expect(clampNotesColumnWidth(700, 1000)).toBe(500);
  });

  test('the maximum itself passes through', () => {
    expect(clampNotesColumnWidth(640, 1280)).toBe(640);
  });

  test('a width above the maximum falls to the cap', () => {
    expect(clampNotesColumnWidth(1000, 1280)).toBe(640);
  });

  test('a width inside the bounds passes through', () => {
    expect(clampNotesColumnWidth(320, 1280)).toBe(320);
  });
});

describe('readNotesColumnWidth', () => {
  test('without a window there is nothing to read: the default', () => {
    unstubWindow();
    expect(readNotesColumnWidth()).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
  });

  test('a missing stored value falls back to the default', () => {
    stubWindow();
    expect(readNotesColumnWidth()).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
  });

  test('a stored width inside the bounds is read back', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '400');
    stubWindow({ localStorage: workingStorage, innerWidth: 1200 });
    expect(readNotesColumnWidth()).toBe(400);
  });

  test('a stored width below the bounds is clamped', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '100');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(NOTES_COLUMN_MIN_WIDTH);
  });

  test('a stored width above half the window is clamped', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '9999');
    stubWindow({ localStorage: workingStorage, innerWidth: 1000 });
    expect(readNotesColumnWidth()).toBe(500);
  });

  test('a stored width above the fallback bound is clamped when the viewport is unknown', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '9999');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(FALLBACK_NOTES_COLUMN_MAX_WIDTH);
  });

  test('a corrupted value falls back to the default', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, 'not-a-number');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
  });

  test('an empty value falls back to the default', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
  });

  test('a failing localStorage falls back to the default', () => {
    stubWindow({
      getItem: () => { throw new Error('denied'); },
    });
    expect(readNotesColumnWidth()).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
  });
});

describe('writeNotesColumnWidth', () => {
  test('the width is stored as text under the samobranka key', () => {
    stubWindow();
    writeNotesColumnWidth(400);
    expect(stored.get(NOTES_COLUMN_WIDTH_KEY)).toBe('400');
  });

  test('a written width reads back on the next launch', () => {
    stubWindow({ localStorage: workingStorage, innerWidth: 1200 });
    writeNotesColumnWidth(410);
    expect(readNotesColumnWidth()).toBe(410);
  });

  test('without a window the write is a no-op', () => {
    unstubWindow();
    expect(() => writeNotesColumnWidth(400)).not.toThrow();
  });

  test('a failing localStorage does not break the end of a drag', () => {
    stubWindow({
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => writeNotesColumnWidth(400)).not.toThrow();
  });
});
