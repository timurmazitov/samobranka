/**
 * Meeting details split view (spec `.scratch/meeting-view-toggle`, ticket 01):
 * one text column with a «Конспект / Транскрипт» switch on every screen size.
 *
 * Seam 2 from the spec's Testing Decisions: the real `MeetingDetailsSplitView`
 * with two fake child panels. Asserts that both tab buttons show regardless of
 * viewport width, that switching unmounts the inactive panel (a fake panel
 * records its unmount), and that the drag resizer, the pane-width CSS variable
 * and the old pane-ratio localStorage key are gone.
 *
 * The Radix tabs stay real (like in `panel-meeting-date.test.tsx`) so that
 * unmount-on-switch is observable; Radix needs `requestAnimationFrame` and the
 * window shim below. Runs green only against the single-column layout.
 */

import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// Radix Presence picks React.useLayoutEffect only when `document` exists at
// module load; without it the hook is a no-op and an inactive tab would never
// unmount here (in the app a document always exists). Declared before the
// component import below so the Radix modules load with the real hook.
(globalThis as any).document = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

const RATIO_STORAGE_KEY = 'samobranka.meetingDetails.transcriptPaneRatio';

const stored = new Map<string, string>();
const storageReads: string[] = [];
let desktopViewport = true;

beforeEach(() => {
  stored.clear();
  storageReads.length = 0;
  desktopViewport = true;
  const localStorageShim = {
    getItem: (key: string) => {
      storageReads.push(key);
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
    removeItem: (key: string) => {
      stored.delete(key);
    },
  };
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
  // The split view used to read the pane ratio through the bare global.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: localStorageShim,
  });
  (globalThis as any).window = {
    matchMedia: () => ({
      matches: desktopViewport,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    localStorage: localStorageShim,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
});

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  Reflect.deleteProperty(globalThis, 'window');
  Reflect.deleteProperty(globalThis, 'localStorage');
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
});

const { MeetingDetailsSplitView } = await import(
  '../../src/components/MeetingDetails/MeetingDetailsSplitView'
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

function tabButtons(instance: ReactTestRenderer) {
  return instance.root.findAll(
    (node) => typeof node.type === 'string' && node.type === 'button' && node.props.role === 'tab',
  );
}

function mountedPanels(instance: ReactTestRenderer): string[] {
  return instance.root
    .findAll((node) => typeof node.type === 'string' && node.props['data-panel'])
    .map((node) => node.props['data-panel'] as string);
}

/** A panel that records its mount and unmount, standing in for the real one. */
function fakePanel(name: 'transcript' | 'summary', events: string[]) {
  return function FakePanel() {
    React.useEffect(() => {
      events.push(`${name}:mount`);
      return () => {
        events.push(`${name}:unmount`);
      };
    }, []);
    return <div data-panel={name} />;
  };
}

type Tab = 'transcript' | 'summary';

function splitViewElement(activeTab: Tab, events: string[], onTabChange: (tab: Tab) => void) {
  const TranscriptFake = fakePanel('transcript', events);
  const SummaryFake = fakePanel('summary', events);
  return (
    <MeetingDetailsSplitView
      activeTab={activeTab}
      onTabChange={onTabChange}
      transcript={<TranscriptFake />}
      summary={<SummaryFake />}
    />
  );
}

async function renderSplitView(element: React.ReactElement) {
  await act(async () => {
    renderer = create(element);
  });
  return renderer!;
}

/** The tab strip must never be hidden at any breakpoint. */
function expectTabStripAlwaysVisible(instance: ReactTestRenderer) {
  const tabs = tabButtons(instance);
  expect(tabs).toHaveLength(2);
  const labels = tabs.map((tab) => textOf(tab.props.children));
  expect(labels).toContain(lookup('meetingDetails.split.tabTranscript'));
  expect(labels).toContain(lookup('meetingDetails.split.tabSummary'));
  for (const tab of tabs) {
    let node: any = tab;
    while (node) {
      const classes = String(node.props?.className ?? '');
      expect(classes).not.toMatch(/(^|\s)([a-z]+:)?hidden(\s|$)/);
      node = node.parent;
    }
  }
}

describe('MeetingDetailsSplitView', () => {
  test('shows both tab buttons on a wide viewport, highlighting the active one', async () => {
    desktopViewport = true;
    const view = await renderSplitView(splitViewElement('transcript', [], () => {}));

    expectTabStripAlwaysVisible(view);

    const active = tabButtons(view).filter((tab) => tab.props['data-state'] === 'active');
    expect(active).toHaveLength(1);
    expect(textOf(active[0].props.children)).toContain(lookup('meetingDetails.split.tabTranscript'));
  });

  test('shows both tab buttons on a narrow viewport', async () => {
    desktopViewport = false;
    const view = await renderSplitView(splitViewElement('summary', [], () => {}));

    expectTabStripAlwaysVisible(view);

    const active = tabButtons(view).filter((tab) => tab.props['data-state'] === 'active');
    expect(active).toHaveLength(1);
    expect(textOf(active[0].props.children)).toContain(lookup('meetingDetails.split.tabSummary'));
  });

  test('switching tabs unmounts the inactive panel instead of hiding it', async () => {
    const events: string[] = [];
    const view = await renderSplitView(splitViewElement('transcript', events, () => {}));

    // Only the active panel is mounted.
    expect(events).toEqual(['transcript:mount']);
    expect(mountedPanels(view)).toEqual(['transcript']);

    await act(async () => {
      view.update(splitViewElement('summary', events, () => {}));
    });

    // The transcript panel recorded its unmount; only the summary panel lives.
    expect(events).toContain('transcript:unmount');
    expect(events).toContain('summary:mount');
    expect(mountedPanels(view)).toEqual(['summary']);
  });

  test('clicking a tab button asks the parent to switch tabs', async () => {
    const requested: Tab[] = [];
    const view = await renderSplitView(
      splitViewElement('transcript', [], (tab) => requested.push(tab)),
    );

    const summaryTab = tabButtons(view).find((tab) =>
      textOf(tab.props.children).includes(lookup('meetingDetails.split.tabSummary')),
    );
    expect(summaryTab).toBeDefined();
    await act(async () => {
      summaryTab!.props.onMouseDown({ button: 0, ctrlKey: false, preventDefault: () => {} });
    });

    expect(requested).toEqual(['summary']);
  });

  test('has no resizer and leaves the old pane-ratio storage key untouched', async () => {
    stored.set(RATIO_STORAGE_KEY, '0.42');
    const events: string[] = [];
    const view = await renderSplitView(splitViewElement('transcript', events, () => {}));

    expect(view.root.findAll((node) => node.props?.role === 'separator')).toHaveLength(0);
    for (const node of view.root.findAll(() => true)) {
      expect(String(node.props?.className ?? '')).not.toContain('cursor-col-resize');
      const style = node.props?.style;
      const hasPaneWidthVar =
        style !== null && typeof style === 'object' && '--transcript-pane-width' in style;
      expect(hasPaneWidthVar).toBe(false);
    }

    await act(async () => {
      view.update(splitViewElement('summary', events, () => {}));
    });

    // The retired key is neither read nor written, so a stored ratio is ignored.
    expect(storageReads).not.toContain(RATIO_STORAGE_KEY);
    expect(stored.get(RATIO_STORAGE_KEY)).toBe('0.42');
  });
});
