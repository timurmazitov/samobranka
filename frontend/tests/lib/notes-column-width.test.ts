/**
 * Notes-column width persistence (spec `.scratch/notes-column`, ticket 04) —
 * seam 3 from the spec's Testing Decisions: the clamp helper and the
 * localStorage read/write behind the column's resize handle. The bounds
 * (240–480px), the default (320px) and the `samobranka.notesColumn.width`
 * key are fixed by the spec. A stored value is honored only when it parses
 * to a finite number, and it is clamped into the bounds; a corrupted or
 * out-of-range entry falls back like a missing one.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_NOTES_COLUMN_WIDTH,
  NOTES_COLUMN_MAX_WIDTH,
  NOTES_COLUMN_MIN_WIDTH,
  NOTES_COLUMN_WIDTH_KEY,
  clampNotesColumnWidth,
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

function stubWindow(localStorage: unknown = workingStorage) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
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
  test('the bounds, the default and the storage key are the spec values', () => {
    expect(NOTES_COLUMN_MIN_WIDTH).toBe(240);
    expect(NOTES_COLUMN_MAX_WIDTH).toBe(480);
    expect(DEFAULT_NOTES_COLUMN_WIDTH).toBe(320);
    expect(NOTES_COLUMN_WIDTH_KEY).toBe('samobranka.notesColumn.width');
  });
});

describe('clampNotesColumnWidth', () => {
  test('a width below the minimum rises to 240', () => {
    expect(clampNotesColumnWidth(239)).toBe(240);
  });

  test('the minimum itself passes through', () => {
    expect(clampNotesColumnWidth(240)).toBe(240);
  });

  test('the maximum itself passes through', () => {
    expect(clampNotesColumnWidth(480)).toBe(480);
  });

  test('a width above the maximum falls to 480', () => {
    expect(clampNotesColumnWidth(481)).toBe(480);
  });

  test('a width inside the bounds passes through', () => {
    expect(clampNotesColumnWidth(320)).toBe(320);
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
    stubWindow();
    expect(readNotesColumnWidth()).toBe(400);
  });

  test('a stored width below the bounds is clamped', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '100');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(NOTES_COLUMN_MIN_WIDTH);
  });

  test('a stored width above the bounds is clamped', () => {
    stored.set(NOTES_COLUMN_WIDTH_KEY, '9999');
    stubWindow();
    expect(readNotesColumnWidth()).toBe(NOTES_COLUMN_MAX_WIDTH);
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
    stubWindow();
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
