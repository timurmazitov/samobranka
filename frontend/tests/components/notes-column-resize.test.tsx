/**
 * Notes-column resize (spec `.scratch/notes-column`, ticket 04): the drag
 * handle on the column's right edge. The real `NotesColumn` is rendered
 * inside the real provider — only the native edge and the chrome around it
 * are replaced — so the observed behavior is the user-visible one: the
 * stored width is restored on launch, dragging the separator moves the
 * column width within the 240–480px bounds, text selection is suspended for
 * the drag, and the final width is persisted on mouseup. The window is an
 * EventTarget here, so the drag's window-level mousemove/mouseup listeners
 * are exercised the way the browser drives them.
 */

import React from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import i18n from '../../src/i18n';
import { DEFAULT_NOTES_COLUMN_WIDTH, NOTES_COLUMN_WIDTH_KEY } from '../../src/lib/notes-column-width';

const originals = await Promise.all(
  [
    '@tauri-apps/api/core',
    '@tauri-apps/api/event',
    'next/navigation',
    '../../src/contexts/RecordingStateContext',
    '../../src/contexts/ImportDialogContext',
    '../../src/components/ui/dialog',
    '../../src/components/ui/tooltip',
    'sonner',
  ].map(async path => [path, { ...(await import(path)) }] as const),
);
afterAll(async () => {
  await act(async () => { await i18n.changeLanguage('en'); });
  for (const [path, exports] of originals) mock.module(path, () => exports);
});

const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;

let listRows: unknown[] = [];
const invoke = mock(async (command: string): Promise<unknown> => {
  if (command === 'api_get_meetings') return listRows;
  if (command === 'doodle_sync') return null;
  if (command === 'api_search_transcripts') return [];
  throw new Error(`Unexpected command: ${command}`);
});
mock.module('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }));
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => { },
  emit: async () => { },
}));
mock.module('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => { }, replace: () => { } }),
}));
mock.module('../../src/contexts/RecordingStateContext', () => ({
  useRecordingState: () => ({ isRecording: false }),
}));
mock.module('../../src/contexts/ImportDialogContext', () => ({
  useImportDialog: () => ({ openImportDialog: () => { } }),
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
mock.module('sonner', () => ({ toast: { success: () => { }, error: () => { }, warning: () => { }, info: () => { } } }));

const { SidebarProvider, useSidebar } = await import('../../src/components/Sidebar/SidebarProvider');
const { default: NotesColumn } = await import('../../src/components/NotesColumn');
const { default: MainContent } = await import('../../src/components/MainContent');

/** Map-backed localStorage; the component reads and writes through `window`. */
const stored = new Map<string, string>();
const localStorageShim = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value); },
  removeItem: (key: string) => { stored.delete(key); },
};

let renderer: ReactTestRenderer | undefined;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  invoke.mockClear();
  stored.clear();
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** The shimmed body's style object; the drag toggles its `userSelect`. */
let bodyStyle: Record<string, string> = {};

/** Live context snapshot, so the tests observe the provider's state directly. */
let context = { isNotesColumnResizing: false, notesColumnWidth: 0 };
const Probe = () => {
  const { isNotesColumnResizing, notesColumnWidth } = useSidebar();
  context = { isNotesColumnResizing, notesColumnWidth };
  return null;
};

/** Provider + column + one offset consumer, mounted the way the app layout mounts them. */
function Harness({ columnVisible = true }: { columnVisible?: boolean }) {
  return (
    <SidebarProvider>
      <Probe />
      {columnVisible ? <NotesColumn /> : null}
      <MainContent>content</MainContent>
    </SidebarProvider>
  );
}

async function show() {
  // The drag listens on the window, so it must dispatch events; the provider
  // listens on the document, and the drag toggles the body's user-select.
  bodyStyle = {};
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), {
      visibilityState: 'visible',
      body: { style: bodyStyle },
    }),
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: Object.assign(new EventTarget(), { localStorage: localStorageShim }),
  });
  await act(async () => {
    renderer = create(<Harness />);
  });
  await act(async () => { });
  await act(async () => { });
  return renderer!;
}

function columnWidth(view: ReactTestRenderer): number {
  return view.root.find((node) => node.type === 'aside').props.style.width;
}

function resizeHandle(view: ReactTestRenderer) {
  return view.root.find((node) => node.props.role === 'separator');
}

function mouse(type: string, clientX: number): Event {
  return Object.assign(new Event(type), { clientX });
}

/** The React synthetic-event stand-in the handle's onMouseDown receives. */
function mouseDownAt(clientX: number) {
  return { clientX, preventDefault: () => { } };
}

test('a width stored by an earlier launch is restored', async () => {
  stored.set(NOTES_COLUMN_WIDTH_KEY, '410');

  const view = await show();

  expect(columnWidth(view)).toBe(410);
});

test('a corrupted stored width falls back to the default', async () => {
  stored.set(NOTES_COLUMN_WIDTH_KEY, 'enormous');

  const view = await show();

  expect(columnWidth(view)).toBe(DEFAULT_NOTES_COLUMN_WIDTH);
});

test('the resize handle is an accessible vertical separator', async () => {
  const view = await show();

  const handle = resizeHandle(view);
  expect(handle.props['aria-orientation']).toBe('vertical');
  expect(handle.props['aria-label']).toBe('Resize notes column');
});

test('dragging the handle moves the column width within the bounds', async () => {
  const view = await show();
  const handle = resizeHandle(view);

  await act(async () => { handle.props.onMouseDown(mouseDownAt(400)); });
  // 60px to the right of the drag start widens the 320px column to 380.
  await act(async () => { window.dispatchEvent(mouse('mousemove', 460)); });
  expect(columnWidth(view)).toBe(380);
  // Far past the bounds the width stops at 480 and 240.
  await act(async () => { window.dispatchEvent(mouse('mousemove', 900)); });
  expect(columnWidth(view)).toBe(480);
  await act(async () => { window.dispatchEvent(mouse('mousemove', 100)); });
  expect(columnWidth(view)).toBe(240);
});

test('the drag suspends text selection and mouseup restores it', async () => {
  const view = await show();
  bodyStyle.userSelect = 'text';
  const handle = resizeHandle(view);

  await act(async () => { handle.props.onMouseDown(mouseDownAt(400)); });
  expect(bodyStyle.userSelect).toBe('none');

  await act(async () => { window.dispatchEvent(mouse('mouseup', 460)); });
  expect(bodyStyle.userSelect).toBe('text');
});

test('mouseup persists the final width and ends the drag', async () => {
  const view = await show();
  const handle = resizeHandle(view);

  await act(async () => { handle.props.onMouseDown(mouseDownAt(400)); });
  await act(async () => { window.dispatchEvent(mouse('mousemove', 450)); });
  await act(async () => { window.dispatchEvent(mouse('mouseup', 450)); });

  expect(columnWidth(view)).toBe(370);
  expect(stored.get(NOTES_COLUMN_WIDTH_KEY)).toBe('370');

  // The listeners are gone: further mouse movement changes nothing.
  await act(async () => { window.dispatchEvent(mouse('mousemove', 600)); });
  expect(columnWidth(view)).toBe(370);
});

test('the column and the content offset drop their transition only while dragging', async () => {
  const view = await show();
  const aside = () => view.root.find((node) => node.type === 'aside');
  const main = () => view.root.find((node) => node.type === 'main');

  // At rest both animate — the sidebar collapse keeps its animation.
  expect(aside().props.className).toContain('transition-all');
  expect(main().props.className).toContain('transition-all');

  const handle = resizeHandle(view);
  await act(async () => { handle.props.onMouseDown(mouseDownAt(400)); });
  await act(async () => { window.dispatchEvent(mouse('mousemove', 460)); });

  // Mid-drag the width follows the cursor instead of animating behind it.
  expect(columnWidth(view)).toBe(380);
  expect(aside().props.className).not.toContain('transition-all');
  expect(main().props.className).not.toContain('transition-all');

  await act(async () => { window.dispatchEvent(mouse('mouseup', 460)); });

  // The drag is over: the transitions return for the next sidebar collapse.
  expect(aside().props.className).toContain('transition-all');
  expect(main().props.className).toContain('transition-all');
});

test('unmounting the column mid-drag ends the drag and restores the page', async () => {
  const view = await show();
  bodyStyle.userSelect = 'text';
  const handle = resizeHandle(view);

  await act(async () => { handle.props.onMouseDown(mouseDownAt(400)); });
  await act(async () => { window.dispatchEvent(mouse('mousemove', 460)); });
  expect(context).toEqual({ isNotesColumnResizing: true, notesColumnWidth: 380 });
  expect(bodyStyle.userSelect).toBe('none');

  // The column goes away while the mouse is still down: the drag must not
  // outlive it — selection comes back, transitions come back.
  await act(async () => { view.update(<Harness columnVisible={false} />); });
  expect(context.isNotesColumnResizing).toBe(false);
  expect(bodyStyle.userSelect).toBe('text');

  // The window listeners are gone: moving and releasing the mouse changes
  // nothing and persists nothing.
  await act(async () => { window.dispatchEvent(mouse('mousemove', 900)); });
  await act(async () => { window.dispatchEvent(mouse('mouseup', 900)); });
  expect(context.notesColumnWidth).toBe(380);
  expect(stored.get(NOTES_COLUMN_WIDTH_KEY)).toBeUndefined();
});
