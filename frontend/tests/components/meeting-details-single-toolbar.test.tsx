/**
 * Single toolbar bar (spec `.scratch/meeting-view-toggle`, ticket 06):
 * the «Транспект / Конспект» toggles and the ACTIVE mode's buttons share one
 * row, rendered by `MeetingDetailsSplitView`; panels register their button
 * row through the `PanelToolbarOutletContext` and render their local header
 * only as a fallback outside a split view.
 *
 * Seam-2 style harness (like meeting-details-split-view.test.tsx): the real
 * split view, real Radix tabs, fake panels. Asserts that the active panel's
 * toolbar lands in the bar (outside any tabpanel, next to the toggles), that
 * switching tabs swaps the bar's buttons, and that a standalone panel keeps
 * its local header instead.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Radix Presence picks React.useLayoutEffect only when `document` exists at
// module load; without it the hook is a no-op and an inactive tab would never
// unmount here (in the app a document always exists). Declared before the
// component imports below so the Radix modules load with the real hook.
(globalThis as any).document = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

beforeEach(() => {
  // Radix (tabs) schedules a mount animation on the bare global.
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: () => void) => {
      callback();
      return 0;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    value: () => {},
  });
  (globalThis as any).window = {
    matchMedia: () => ({
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  };
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

const { MeetingDetailsSplitView } = await import(
  '../../src/components/MeetingDetails/MeetingDetailsSplitView'
);
const { usePanelToolbar } = await import(
  '../../src/components/MeetingDetails/panel-toolbar'
);
const { default: i18n } = await import('../../src/i18n');
const en = (await import('../../src/i18n/locales/en/translation.json')).default;

await i18n.changeLanguage('en');

function lookup(key: string): string {
  const value = key.split('.').reduce((acc: any, part) => acc?.[part], en);
  if (typeof value !== 'string') throw new Error(`catalog key ${key} is missing`);
  return value;
}

function textOf(node: any): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node?.children) return node.children.map(textOf).join('');
  return '';
}

/** A panel whose button row registers in the shared bar (like the real ones). */
function fakePanel(name: 'transcript' | 'summary') {
  return function FakePanel() {
    const inBar = usePanelToolbar(
      <button type="button" data-toolbar={name}>{`${name} actions`}</button>,
    );
    return <div data-panel={name}>{!inBar && <span data-fallback-toolbar={name} />}</div>;
  };
}

type Tab = 'transcript' | 'summary';

function splitViewElement(activeTab: Tab, onTabChange: (tab: Tab) => void) {
  const TranscriptFake = fakePanel('transcript');
  const SummaryFake = fakePanel('summary');
  return (
    <MeetingDetailsSplitView
      activeTab={activeTab}
      onTabChange={onTabChange}
      transcript={<TranscriptFake />}
      summary={<SummaryFake />}
    />
  );
}

async function render(element: React.ReactElement) {
  await act(async () => {
    renderer = create(element);
  });
  return renderer!;
}

function tabButtons(instance: ReactTestRenderer) {
  return instance.root.findAll(
    (node) => typeof node.type === 'string' && node.type === 'button' && node.props.role === 'tab',
  );
}

function toolbarButton(instance: ReactTestRenderer, name: Tab) {
  return instance.root.findAll(
    (node) => typeof node.type === 'string' && node.props['data-toolbar'] === name,
  )[0];
}

/** All ancestor instances of a test instance, nearest first. */
function ancestors(node: any): any[] {
  const chain: any[] = [];
  let current = node.parent;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain;
}

describe('single toolbar bar', () => {
  test('renders the active panel buttons next to the toggles, outside the tabpanel', async () => {
    const view = await render(splitViewElement('transcript', () => {}));

    const toolbar = toolbarButton(view, 'transcript');
    expect(toolbar).toBeDefined();
    expect(toolbarButton(view, 'summary')).toBeUndefined();

    // The bar hosts BOTH the toggles and the panel buttons: their nearest
    // common ancestor is the bordered toolbar bar, which lies outside any
    // tabpanel content.
    const toolbarChain = ancestors(toolbar);
    expect(toolbarChain.some((node) => node.props?.role === 'tabpanel')).toBe(false);
    const bar = nearestCommon(toolbar, tabButtons(view)[0]);
    expect(bar).toBeDefined();
    expect(toolbarChain).toContain(bar);
    expect(String(bar.props.className ?? '')).toContain('border-b');
    // ... and the panel itself stays mounted with its content.
    expect(
      view.root.findAll((node) => typeof node.type === 'string' && node.props['data-panel']),
    ).toHaveLength(1);
  });

  test('switching tabs swaps the bar buttons to the new mode', async () => {
    const view = await render(splitViewElement('transcript', () => {}));
    expect(toolbarButton(view, 'transcript')).toBeDefined();

    await act(async () => {
      view.update(splitViewElement('summary', () => {}));
    });

    expect(toolbarButton(view, 'transcript')).toBeUndefined();
    expect(toolbarButton(view, 'summary')).toBeDefined();
    expect(
      view.root.findAll((node) => typeof node.type === 'string' && node.props['data-panel']),
    ).toHaveLength(1);
    expect(
      view.root.findAll(
        (node) => typeof node.type === 'string' && node.props['data-panel'] === 'summary',
      ),
    ).toHaveLength(1);
  });

  test('a panel outside a split view keeps its own header', async () => {
    const LonePanel = fakePanel('transcript');
    const view = await render(<LonePanel />);

    expect(toolbarButton(view, 'transcript')).toBeUndefined();
    expect(
      view.root.findAll(
        (node) => typeof node.type === 'string' && node.props['data-fallback-toolbar'],
      ),
    ).toHaveLength(1);
  });
});

/** Nearest common ancestor of two test instances (root guaranteed to exist). */
function nearestCommon(a: any, b: any): any {
  const bChain = new Set(ancestors(b));
  let current = a;
  while (current) {
    if (bChain.has(current)) return current;
    current = current.parent;
  }
  return undefined;
}
