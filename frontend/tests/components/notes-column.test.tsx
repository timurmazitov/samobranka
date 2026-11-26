import React from 'react';
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import i18n from '../../src/i18n';

// The real notes column is rendered inside the real provider: only the native
// edge and the heavy chrome around it are replaced, so the meeting list with
// its search row, empty state, modals and hover popup is what this suite
// observes. The column is permanent, so no sidebar expanding is needed.
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
/** Scripted backend for `api_get_meeting_speakers`; an Error rejects it. */
let speakerRows: unknown = [];
const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'api_get_meetings') return listRows;
  if (command === 'doodle_sync') return null;
  if (command === 'api_search_transcripts') return [];
  if (command === 'api_get_meeting_speakers') {
    if (speakerRows instanceof Error) throw speakerRows;
    return speakerRows;
  }
  throw new Error(`Unexpected command: ${command}`);
});
mock.module('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }));
// The provider subscribes to native events on mount; the subscription itself
// is irrelevant here, only the meeting rows matter.
mock.module('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
}));
mock.module('next/navigation', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: () => {}, replace: () => {} }),
}));
mock.module('../../src/contexts/RecordingStateContext', () => ({
  useRecordingState: () => ({ isRecording: false }),
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
  // The marker and className passthrough let the assertions inspect the popup
  // content and its mouse-muted styling.
  TooltipContent: ({ children, className }: any) => (
    <div data-popup="meeting" className={className}>{children}</div>
  ),
  TooltipProvider: Container,
  TooltipTrigger: Container,
}));
mock.module('../../src/components/Logo', () => ({ default: () => null }));
mock.module('sonner', () => ({ toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} } }));

const { SidebarProvider } = await import('../../src/components/Sidebar/SidebarProvider');
const { default: NotesColumn } = await import('../../src/components/NotesColumn');

let renderer: ReactTestRenderer | undefined;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  invoke.mockClear();
  speakerRows = [];
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/** Local moment, so the expected text does not depend on the machine's zone. */
const recordedAt = new Date(2026, 10, 18, 14, 32).toISOString();

async function show() {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: 'visible' }),
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  await act(async () => {
    renderer = create(<SidebarProvider><NotesColumn /></SidebarProvider>);
  });
  // The provider expands the Meeting Notes folder and fetches its rows.
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

function viewTextOf(instance: ReactTestRenderer): string {
  return textOf(instance.toJSON());
}

test('the column shows the search row above the meeting list', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];

  const view = await show();

  const search = view.root.find(
    (node) => node.type === 'input' && node.props.placeholder === 'Search meeting content...',
  );
  expect(search).toBeDefined();
  expect(viewTextOf(view)).toContain('Planning call');
});

test('an empty meeting list shows the no-notes placeholder', async () => {
  listRows = [];

  const view = await show();

  expect(viewTextOf(view)).toContain('No notes');
});

test('the empty placeholder follows the Russian interface', async () => {
  listRows = [];

  await act(async () => { await i18n.changeLanguage('ru'); });
  try {
    const view = await show();
    expect(viewTextOf(view)).toContain('Нет заметок');
  } finally {
    await act(async () => { await i18n.changeLanguage('en'); });
  }
});

test('a listed recording shows its date and length under the title', async () => {
  listRows = [{
    id: 'meeting-1',
    title: 'Planning call',
    recorded_at: recordedAt,
    duration_seconds: 4_975.5,
  }];

  const view = await show();

  const text = viewTextOf(view);
  expect(text).toContain('Planning call');
  expect(text).toContain('18/11/2026, 14:32 · 1 h 23 min');
});

test('a meeting with neither value shows no second line', async () => {
  listRows = [{ id: 'meeting-2', title: 'Old call' }];

  const view = await show();

  expect(viewTextOf(view)).toContain('Old call');
  expect(viewTextOf(view)).not.toContain('·');
});

test('the clicked row becomes the highlighted active meeting', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];

  const view = await show();
  const row = view.root.findAll(
    (node) => node.type === 'div' && typeof node.props.onClick === 'function'
      && String(node.props.className).includes('cursor-pointer')
      && textOf(node).includes('Planning call'),
  )[0];
  await act(async () => { row.props.onClick(); });

  const active = view.root.findAll(
    (node) => typeof node.props.className === 'string'
      && node.props.className.includes('bg-blue-100')
      && textOf(node).includes('Planning call'),
  );
  expect(active.length).toBeGreaterThanOrEqual(1);
});

// — The row modals ------------------------------------------------------------

/** React synthetic-event stand-in: the row buttons only call `stopPropagation`. */
const fakeEvent = { stopPropagation: () => {}, preventDefault: () => {} };

test('the row edit button opens the edit dialog with the current title', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];

  const view = await show();
  const editButton = view.root.find(
    (node) => node.type === 'button' && node.props['aria-label'] === 'Edit meeting details',
  );
  await act(async () => { editButton.props.onClick(fakeEvent); });

  const titleInput = view.root.find(
    (node) => node.type === 'input' && node.props.id === 'meeting-title',
  );
  expect(titleInput.props.value).toBe('Planning call');
});

test('the row delete button opens the delete confirmation', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];

  const view = await show();
  expect(viewTextOf(view)).not.toContain('Are you sure you want to delete this meeting?');

  const deleteButton = view.root.find(
    (node) => node.type === 'button' && node.props['aria-label'] === 'Delete meeting',
  );
  await act(async () => { deleteButton.props.onClick(fakeEvent); });

  expect(viewTextOf(view)).toContain('Are you sure you want to delete this meeting?');
});

// — The hover popup ---------------------------------------------------------

/** The popup subtree for the row carrying `title`, or undefined. */
function popupFor(view: ReactTestRenderer, title: string) {
  const popups = view.root.findAll(
    (node) => node.props['data-popup'] === 'meeting' && textOf(node.children).includes(title),
  );
  return popups[popups.length - 1];
}

/** Hover the meeting row carrying `title`, the way the mouse does. */
async function hover(view: ReactTestRenderer, title: string) {
  const rows = view.root.findAll(
    (node) => typeof node.props.onMouseEnter === 'function' && textOf(node.children).includes(title),
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  await act(async () => { rows[0].props.onMouseEnter(); });
}

function speakerRequests(): number {
  return invoke.mock.calls.filter((call) => call[0] === 'api_get_meeting_speakers').length;
}

const threeSpeakers = [
  { label: 'speaker_0', speaker_name: null, segment_count: 4, first_start_time: 0 },
  { label: 'speaker_1', speaker_name: 'Ann', segment_count: 2, first_start_time: 30 },
  { label: 'speaker_2', speaker_name: null, segment_count: 1, first_start_time: 61 },
];

test('the hover popup completes the row with the full title, date, length and speakers', async () => {
  listRows = [{
    id: 'meeting-1',
    title: 'Quarterly roadmap alignment with the infrastructure and design teams',
    recorded_at: recordedAt,
    duration_seconds: 4_975.5,
  }];
  speakerRows = threeSpeakers;

  const view = await show();
  await hover(view, 'Quarterly roadmap alignment');

  const popup = textOf(popupFor(view, 'Quarterly roadmap alignment').children);
  // The full title, not the row's two-line clamp.
  expect(popup).toContain('Quarterly roadmap alignment with the infrastructure and design teams');
  // The same date and length strings the row itself shows.
  expect(viewTextOf(view)).toContain('18/11/2026, 14:32 · 1 h 23 min');
  expect(popup).toContain('18/11/2026, 14:32');
  expect(popup).toContain('1 h 23 min');
  expect(popup).toContain('Speakers: 3');
});

test('the speaker count waits for the first hover and is asked only once', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];
  speakerRows = threeSpeakers;

  const view = await show();
  // Listing the meeting alone does not ask the backend about its speakers.
  expect(speakerRequests()).toBe(0);
  expect(textOf(popupFor(view, 'Planning call').children)).not.toContain('Speakers');

  await hover(view, 'Planning call');
  await hover(view, 'Planning call');
  await hover(view, 'Planning call');

  expect(speakerRequests()).toBe(1);
  expect(textOf(popupFor(view, 'Planning call').children)).toContain('Speakers: 3');
});

test('a row that leaves the list and comes back asks for its speakers no further', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];
  speakerRows = threeSpeakers;

  const view = await show();
  await hover(view, 'Planning call');
  expect(speakerRequests()).toBe(1);

  // A search for something else filters the row out of the list; clearing the
  // search brings it back while the column session lives on. The count is
  // cached above the row, so the remounted row does not reach the backend
  // again.
  const search = view.root.find(
    (node) => node.type === 'input' && node.props.placeholder === 'Search meeting content...',
  );
  await act(async () => { search.props.onChange({ target: { value: 'nothing matches this' } }); });
  await act(async () => {});
  expect(viewTextOf(view)).not.toContain('Planning call');
  await act(async () => { search.props.onChange({ target: { value: '' } }); });
  await act(async () => {});

  await hover(view, 'Planning call');
  expect(speakerRequests()).toBe(1);
  expect(textOf(popupFor(view, 'Planning call').children)).toContain('Speakers: 3');
});

test('zero speakers and a failed request leave the speakers line out', async () => {
  listRows = [{ id: 'meeting-1', title: 'Solo call', recorded_at: recordedAt }];
  speakerRows = [];

  const view = await show();
  await hover(view, 'Solo call');
  expect(textOf(popupFor(view, 'Solo call').children)).not.toContain('Speakers');
  await act(async () => renderer!.unmount());
  renderer = undefined;
  invoke.mockClear();

  speakerRows = new Error('diarization backend is down');
  const failed = await show();
  await hover(failed, 'Solo call');
  // No crash, no zero, no line — and the failure is remembered, not retried.
  await hover(failed, 'Solo call');
  const popup = textOf(popupFor(failed, 'Solo call').children);
  expect(popup).not.toContain('Speakers');
  expect(popup).toContain('Solo call');
  expect(speakerRequests()).toBe(1);
});

test('a short title gets the popup too, not only a clamped one', async () => {
  listRows = [{ id: 'meeting-1', title: 'Sync', recorded_at: recordedAt }];

  const view = await show();
  await hover(view, 'Sync');

  const popup = textOf(popupFor(view, 'Sync').children);
  expect(popup).toContain('Sync');
  expect(popup).toContain('18/11/2026, 14:32');
});

test('the popup stays out of the mouse way so the row buttons stay clickable', async () => {
  listRows = [{ id: 'meeting-1', title: 'Planning call', recorded_at: recordedAt }];

  const view = await show();

  const popup = popupFor(view, 'Planning call');
  expect(String(popup.props.className)).toContain('pointer-events-none');
});

test('the popup follows the Russian interface', async () => {
  listRows = [{
    id: 'meeting-ru',
    title: 'Планёрка команды',
    recorded_at: recordedAt,
    duration_seconds: 4_975.5,
  }];
  speakerRows = threeSpeakers.slice(0, 2);

  await act(async () => { await i18n.changeLanguage('ru'); });
  try {
    const view = await show();
    await hover(view, 'Планёрка команды');

    // The row itself and its popup say the same thing.
    expect(viewTextOf(view)).toContain('18.11.2026, 14:32 · 1 ч 23 мин');
    const popup = textOf(popupFor(view, 'Планёрка команды').children);
    expect(popup).toContain('Планёрка команды');
    expect(popup).toContain('18.11.2026, 14:32');
    expect(popup).toContain('1 ч 23 мин');
    expect(popup).toContain('Спикеров: 2');
    expect(popup).not.toContain('участник');
  } finally {
    await act(async () => { await i18n.changeLanguage('en'); });
  }
});
