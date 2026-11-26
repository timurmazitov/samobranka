import { describe, expect, test } from 'bun:test';

import { contentOffset, isNotesColumnRoute, sidebarWidthPx } from '../../src/lib/layout-offset';

describe('sidebarWidthPx', () => {
  test('a collapsed sidebar is 64px wide (Tailwind w-16)', () => {
    expect(sidebarWidthPx(true)).toBe(64);
  });

  test('an expanded sidebar is 256px wide (Tailwind w-64)', () => {
    expect(sidebarWidthPx(false)).toBe(256);
  });
});

describe('contentOffset', () => {
  test('a collapsed sidebar plus the default 320px column leaves a 384px offset', () => {
    expect(contentOffset(true, 320)).toBe('384px');
  });

  test('an expanded sidebar plus the default 320px column leaves a 576px offset', () => {
    expect(contentOffset(false, 320)).toBe('576px');
  });

  test('the offset follows the column width at the resize bounds', () => {
    expect(contentOffset(true, 240)).toBe('304px');
    expect(contentOffset(false, 640)).toBe('896px');
  });

  test('a hidden column (width 0) leaves only the sidebar offset', () => {
    expect(contentOffset(true, 0)).toBe('64px');
    expect(contentOffset(false, 0)).toBe('256px');
  });
});

describe('isNotesColumnRoute', () => {
  test('the meeting page and the legacy notes route show the column', () => {
    expect(isNotesColumnRoute('/meeting-details')).toBe(true);
    expect(isNotesColumnRoute('/notes/legacy1')).toBe(true);
  });

  test('home, settings and feedback hide the column', () => {
    expect(isNotesColumnRoute('/')).toBe(false);
    expect(isNotesColumnRoute('/settings')).toBe(false);
    expect(isNotesColumnRoute('/feedback')).toBe(false);
  });

  test('an unknown or missing pathname hides the column', () => {
    expect(isNotesColumnRoute('/notes')).toBe(false);
    expect(isNotesColumnRoute(null)).toBe(false);
  });
});
