import React from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import i18n from '../../src/i18n';

// Seam #2 of the notes-column spec: the real Sidebar inside the real
// SidebarProvider, with the native edge and the router replaced. The suite
// observes the notes-mode button (the collapsed-panel icon and the expanded
// nav row): where it navigates, when it stays put, and when it is
// highlighted. The meeting list itself lives in the notes column now and is
// covered by notes-column.test.tsx.
const originals = await Promise.all(
  [
    '@tauri-apps/api/core',
    '@tauri-apps/api/event',
    'next/navigation',
    '../../src/contexts/RecordingStateContext',
    '../../src/contexts/ImportDialogContext',
    '../../src/components/ui/dialog',
    '../../src/components/ui/tooltip',
    '../../src/components/Logo',
    'sonner',
  ].map(async path => [path, { ...(await import(path)) }] as const),
);
afterAll(async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

let listRows: unknown[] = [];
let currentPathname = '/';
let recordingNow = false;
let pushCalls: string[] = [];

const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meetings') return listRows;
  if (command === 'doodle_sync') return null;
  if (command === 'api_get_model_config') return null;
  if (command === 'api_get_transcript_config') return null;
  throw new Error(`Unexpected command: ${command}`);
});
mock.module('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }));
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}));
mock.module('next/navigation', () => ({
  usePathname: () => currentPathname,
  useRouter: () => ({ push: (path: string) => { pushCalls.push(path); }, replace: () => {} }),
}));
mock.module('../../src/contexts/RecordingStateContext', () => ({
  useRecordingState: () => ({ isRecording: recordingNow }),
}));
mock.module('../../src/contexts/ImportDialogContext', () => ({
  useImportDialog: () => ({ openImportDialog: () => {} }),
}));
mock.module('../../src/components/ui/dialog', () => ({
  Dialog: Container,
  DialogContent: Container,
  DialogFooter: Container,
  DialogTitle: Container,
  DialogTrigger: Container,
}));
mock.module('../../src/components/ui/tooltip', () => ({
  Tooltip: Container,
  TooltipContent: Container,
  TooltipProvider: Container,
  TooltipTrigger: Container,
}));
mock.module('../../src/components/Logo', () => ({ default: () => null }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} } }));

const { SidebarProvider, useSidebar } = await import('../../src/components/Sidebar/SidebarProvider');
const { default: Sidebar } = await import('../../src/components/Sidebar');

let renderer: ReactTestRenderer | undefined;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  invoke.mockClear();
  listRows = [];
  currentPathname = '/';
  recordingNow = false;
  pushCalls = [];
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** Exposes the provider's current meeting so selection is observable. */
function CurrentMeetingProbe() {
  const { currentMeeting } = useSidebar();
  return <output data-probe="current-meeting">{currentMeeting?.id}</output>;
}

async function show() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  await act(async () => {
    renderer = create(
      <SidebarProvider>
        <Sidebar />
        <CurrentMeetingProbe />
      </SidebarProvider>,
    );
  });
  await act(async () => {});
  await act(async () => {});
  return renderer!;
}

function textOf(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node?.children) return node.children.map(textOf).join('');
  return '';
}

/** The button carrying the given lucide icon (collapsed-panel buttons). */
function buttonWithIcon(view: ReactTestRenderer, iconClass: string) {
  const found = view.root.findAll(
    (node) => node.type === 'button'
      && node.findAll((d) => d.type === 'svg' && String(d.props.className).includes(iconClass)).length > 0,
  );
  expect(found.length).toBeGreaterThanOrEqual(1);
  return found[0];
}

/** The expanded sidebar's «Заметки» nav row. */
function notesModeRow(view: ReactTestRenderer) {
  const found = view.root.findAll(
    (node) => node.type === 'div' && typeof node.props.onClick === 'function'
      && node.findAll((d) => d.type === 'svg' && String(d.props.className).includes('lucide-notebook-pen')).length > 0,
  );
  expect(found.length).toBe(1);
  return found[0];
}

/** Expand the collapsed sidebar through its floating toggle. */
async function expandSidebar(view: ReactTestRenderer) {
  const toggle = buttonWithIcon(view, 'lucide-circle-chevron-right');
  await act(async () => { toggle.props.onClick(); });
  await act(async () => {});
}

/** All expanded-sidebar «Заметки» nav rows (0 while the panel is collapsed). */
function notesModeRows(view: ReactTestRenderer) {
  return view.root.findAll(
    (node) => node.type === 'div' && typeof node.props.onClick === 'function'
      && node.findAll((d) => d.type === 'svg' && String(d.props.className).includes('lucide-notebook-pen')).length > 0,
  );
}

/** The active-mode class as an exact token (`hover:bg-gray-100` is not it). */
function hasActiveHighlight(node: any): boolean {
  return String(node.props.className).split(/\s+/).includes('bg-gray-100');
}

function currentMeetingId(view: ReactTestRenderer): string {
  const probe = view.root.find((node) => node.props['data-probe'] === 'current-meeting');
  return textOf(probe.children);
}

const planningCall = { id: 'meeting-a', title: 'Planning call' };

test('from home the notes button opens the newest meeting and selects it', async () => {
  currentPathname = '/';
  // The backend list is newest-first; the first row is the latest meeting.
  listRows = [planningCall, { id: 'meeting-b', title: 'Older call' }];

  const view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });

  expect(pushCalls).toEqual(['/meeting-details?id=meeting-a']);
  expect(currentMeetingId(view)).toBe('meeting-a');
});

test('the notes button routes the newest meeting by its id shape', async () => {
  currentPathname = '/settings';

  // A dashed id gets the full meeting page.
  listRows = [planningCall];
  let view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });
  expect(pushCalls).toEqual(['/meeting-details?id=meeting-a']);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  pushCalls = [];
  invoke.mockClear();

  // The intro call stays on the home page.
  listRows = [{ id: 'intro-call', title: '+ New Call' }];
  view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });
  expect(pushCalls).toEqual(['/']);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  pushCalls = [];
  invoke.mockClear();

  // Anything else uses the legacy notes route.
  listRows = [{ id: 'legacy1', title: 'Old imported call' }];
  view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });
  expect(pushCalls).toEqual(['/notes/legacy1']);
});

test('on a meeting page the notes button is a no-op', async () => {
  listRows = [planningCall];

  currentPathname = '/meeting-details';
  let view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });
  expect(pushCalls).toEqual([]);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  invoke.mockClear();

  currentPathname = '/notes/legacy1';
  view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });
  expect(pushCalls).toEqual([]);
});

test('while recording the notes button does not navigate', async () => {
  currentPathname = '/';
  recordingNow = true;
  listRows = [planningCall];

  const view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });

  expect(pushCalls).toEqual([]);
});

test('with no meetings the notes button stays put', async () => {
  currentPathname = '/';
  listRows = [];

  const view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });

  expect(pushCalls).toEqual([]);
});

test('the notes button is highlighted on notes pages and not on settings', async () => {
  listRows = [planningCall];

  for (const pathname of ['/', '/meeting-details', '/notes/legacy1']) {
    currentPathname = pathname;
    const view = await show();
    expect(hasActiveHighlight(buttonWithIcon(view, 'lucide-notebook-pen'))).toBe(true);
    await act(async () => renderer!.unmount());
    renderer = undefined;
    invoke.mockClear();
  }

  currentPathname = '/settings';
  const view = await show();
  expect(hasActiveHighlight(buttonWithIcon(view, 'lucide-notebook-pen'))).toBe(false);
});

test('from settings the notes button opens the newest meeting', async () => {
  currentPathname = '/settings';
  listRows = [planningCall];

  const view = await show();
  await act(async () => { buttonWithIcon(view, 'lucide-notebook-pen').props.onClick(); });

  expect(pushCalls).toEqual(['/meeting-details?id=meeting-a']);
});

test('the expanded nav row navigates like the icon and shows the active mode', async () => {
  currentPathname = '/';
  listRows = [planningCall];

  const view = await show();
  await expandSidebar(view);

  const row = notesModeRow(view);
  expect(hasActiveHighlight(row)).toBe(true);

  await act(async () => { row.props.onClick(); });
  expect(pushCalls).toEqual(['/meeting-details?id=meeting-a']);
});

test('the expanded nav row is not highlighted on settings', async () => {
  currentPathname = '/settings';
  listRows = [planningCall];

  const view = await show();
  await expandSidebar(view);

  expect(hasActiveHighlight(notesModeRow(view))).toBe(false);
});

test('the bottom-left corner toggle expands the sidebar and collapses it back', async () => {
  currentPathname = '/settings';
  listRows = [planningCall];

  const view = await show();
  // Collapsed: no expanded nav row anywhere.
  expect(notesModeRows(view).length).toBe(0);

  await expandSidebar(view);
  expect(notesModeRows(view).length).toBe(1);

  // Expanded: the toggle flips to the left chevron and collapses the panel.
  const collapse = buttonWithIcon(view, 'lucide-circle-chevron-left');
  await act(async () => { collapse.props.onClick(); });
  await act(async () => {});
  expect(notesModeRows(view).length).toBe(0);
});
