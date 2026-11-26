import { describe, expect, test } from 'bun:test';

import { contentOffset } from '../../src/lib/layout-offset';

describe('contentOffset', () => {
  test('a collapsed sidebar leaves the content a 4rem offset', () => {
    expect(contentOffset(true)).toBe('4rem');
  });

  test('an expanded sidebar leaves the content a 16rem offset', () => {
    expect(contentOffset(false)).toBe('16rem');
  });
});
