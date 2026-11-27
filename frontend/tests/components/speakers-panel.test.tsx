import React from 'react';
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The Speakers panel lives inside a Radix Sheet / Popover / Command stack. None
// of those render without a DOM, so the app wrappers are replaced with plain
// containers. The Sheet keeps its real `open`/`onOpenChange` contract; the last
// handler is captured so a test can trigger Escape / outside-click dismissal.
const Container = ({ children }: any) => <div>{children}</div>;

let sheetOnOpenChange: ((open: boolean) => void) | null = null;
mock.module('../../src/components/ui/sheet', () => ({
  Sheet: ({ open, onOpenChange, children }: any) => {
    sheetOnOpenChange = onOpenChange;
    return open ? <div>{children}</div> : null;
  },
  SheetContent: Container,
  SheetHeader: Container,
  SheetFooter: Container,
  SheetTitle: Container,
  SheetDescription: Container,
  SheetClose: Container,
  SheetTrigger: Container,
  SheetPortal: Container,
  SheetOverlay: Container,
}));
const originalSheet = { ...(await import('../../src/components/ui/sheet')) };
afterAll(() => {
  mock.module('../../src/components/ui/sheet', () => originalSheet);
});

// Popover content stays mounted so the picker list is observable; the component
// under test still owns all the ordering / filtering logic.
mock.module('../../src/components/ui/popover', () => ({
  Popover: Container,
  PopoverTrigger: Container,
  PopoverContent: Container,
  PopoverAnchor: Container,
}));
const originalPopover = { ...(await import('../../src/components/ui/popover')) };
afterAll(() => {
  mock.module('../../src/components/ui/popover', () => originalPopover);
});

mock.module('../../src/components/ui/command', () => ({
  Command: Container,
  CommandInput: ({ value, onValueChange, placeholder }: any) => (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(event) => onValueChange?.(event.target.value)}
    />
  ),
  CommandList: Container,
  CommandEmpty: Container,
  CommandGroup: Container,
  // Mirrors cmdk: a disabled item is not clickable and never fires `onSelect`
  // (cmdk drops the click handler and marks the node aria-disabled).
  CommandItem: ({ children, onSelect, disabled, className }: any) => (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled || undefined}
      className={className}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
      }}
    >
      {children}
    </button>
  ),
  CommandSeparator: Container,
  CommandShortcut: Container,
}));
const originalCommand = { ...(await import('../../src/components/ui/command')) };
afterAll(() => {
  mock.module('../../src/components/ui/command', () => originalCommand);
});

mock.module('../../src/contexts/ConfigContext', () => ({
  useConfig: () => ({
    selectedLanguage: 'auto',
    transcriptModelConfig: { provider: 'whisper', model: 'large-v3' },
  }),
}));
const originalConfig = { ...(await import('../../src/contexts/ConfigContext')) };
afterAll(() => {
  mock.module('../../src/contexts/ConfigContext', () => originalConfig);
});

// The transcript button group's Export dropdown is Radix-based and needs a
// DOM; the group renders here only as the Speakers button's host, so the menu
// wrappers become plain containers.
mock.module('../../src/components/ui/dropdown-menu', () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: Container,
  DropdownMenuContent: Container,
  DropdownMenuItem: Container,
}));
const originalDropdownMenu = { ...await import('../../src/components/ui/dropdown-menu') };
afterAll(() => {
  mock.module('../../src/components/ui/dropdown-menu', () => originalDropdownMenu);
});

const notify = mock(() => {});
mock.module('sonner', () => ({
  toast: { info: notify, error: notify, success: notify, warning: notify },
}));
const originalToast = { ...(await import('sonner')) };
afterAll(() => {
  mock.module('sonner', () => originalToast);
});

type MeetingSpeaker = import('../../src/types').MeetingSpeaker;

let speakers: MeetingSpeaker[] = [];
/** The whole people directory, as the command returns it (unordered). */
let directory: string[] = [];
let directoryError: string | null = null;
let assignError: string | null = null;

// --- Diarization seams, injected so no Tauri module mocks are needed here ---
type DiarizationResult = import('../../src/lib/diarization').DiarizationResult;
type AudioCppModelInfo = import('../../src/lib/audiocpp').AudioCppModelInfo;

function diarizationResult(
  status: DiarizationResult['status'],
  overrides: Partial<DiarizationResult> = {},
): DiarizationResult {
  return {
    meeting_id: 'meeting-a',
    status,
    labeled_segments: status === 'ran' ? 2 : 0,
    total_segments: 2,
    speakers_available: status === 'ran',
    error: status === 'failed' ? 'engine exploded' : null,
    ...overrides,
  };
}

function diarizationModel(overrides: Partial<AudioCppModelInfo> = {}): AudioCppModelInfo {
  return {
    name: 'nemotron-3-diarization-bf16',
    display_name: 'Nemotron-3 Diarization',
    family: 'nemotron_3_diar',
    task: 'diar',
    quantization: 'BF16',
    filename: 'nemotron-3-diarization-bf16.gguf',
    path: '/models/audiocpp/nemotron-3-diarization-bf16.gguf',
    size_mb: 190,
    size_bytes: 198_720_928,
    description: 'Speaker diarization',
    status: 'Available',
    ...overrides,
  };
}

let diarizationStep: () => Promise<DiarizationResult> = async () => diarizationResult('ran');
const diarizeMeeting = mock(async (_meetingId: string) => diarizationStep());
const diarizationClient = { diarizeMeeting };
let availableModels: AudioCppModelInfo[] = [];
let modelListError: string | null = null;
const getAvailableModels = mock(async () => {
  if (modelListError) throw new Error(modelListError);
  return availableModels;
});
const modelClient = { getAvailableModels };

const invoke = mock(async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
  if (command === 'api_get_meeting_speakers') return speakers;
  if (command === 'api_get_speaker_names') {
    if (directoryError) throw directoryError;
    return directory;
  }
  if (command === 'api_assign_meeting_speakers') {
    if (assignError) throw assignError;
    return speakers;
  }
  throw new Error(`Unexpected command: ${command}`);
});
// Keep the real exports (`transformCallback`, …) that other modules pull in;
// only `invoke` is replaced.
const originalCore = { ...(await import('@tauri-apps/api/core')) };
afterAll(() => {
  mock.module('@tauri-apps/api/core', () => originalCore);
});
const coreMock = () => ({ ...originalCore, invoke });

mock.module('@tauri-apps/api/core', coreMock);

const { TranscriptButtonGroup } = await import(
  '../../src/components/MeetingDetails/TranscriptButtonGroup'
);
const { SpeakersPanel } = await import(
  '../../src/components/MeetingDetails/SpeakersPanel'
);

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  mock.module('@tauri-apps/api/core', coreMock);
  (globalThis as any).window = {
    __TAURI_INTERNALS__: { invoke },
    dispatchEvent: () => true,
  };
  invoke.mockClear();
  notify.mockClear();
  onRefetchTranscripts.mockClear();
  diarizeMeeting.mockClear();
  getAvailableModels.mockClear();
  diarizationStep = async () => diarizationResult('ran');
  availableModels = [];
  modelListError = null;
  sheetOnOpenChange = null;
  assignError = null;
  directoryError = null;
  speakers = [];
  directory = [];
});

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

const onRefetchTranscripts = mock(async () => {});

async function render() {
  await act(async () => {
    renderer = create(
      <TranscriptButtonGroup
        transcriptCount={0}
        onCopyTranscript={() => {}}
        onExportTranscript={() => {}}
        onOpenMeetingFolder={async () => {}}
        meetingId="meeting-a"
        meetingFolderPath="/tmp/meeting-a"
        onRefetchTranscripts={onRefetchTranscripts}
        diarizationClient={diarizationClient}
        diarizationModelClient={modelClient}
      />
    );
  });
  return renderer!;
}

/** Renders the panel itself so the diarization seams can be injected. */
async function renderPanel() {
  await act(async () => {
    renderer = create(
      <SpeakersPanel
        open
        onOpenChange={() => {}}
        meetingId="meeting-a"
        onRefetchTranscripts={onRefetchTranscripts}
        diarizationClient={diarizationClient}
        modelClient={modelClient}
      />
    );
  });
  return renderer!;
}

function nodeText(node: any): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (node?.children) return node.children.map(nodeText).join('');
  return '';
}

function text(instance: ReactTestRenderer): string {
  return nodeText(instance.toJSON());
}

/** Concatenated text of a mounted test instance subtree. */
function instanceText(node: any): string {
  return (node.children ?? [])
    .map((child: any) => (typeof child === 'string' ? child : instanceText(child)))
    .join('');
}

/** Clicks the first button whose subtree text contains `label`. Accepts the
 * renderer itself or any nested test instance (a row). */
async function clickIn(node: any, label: string) {
  const scoped = typeof node.findAll === 'function' ? node : node.root;
  const button = scoped.find(
    (n: any) => n.type === 'button' && instanceText(n).includes(label)
  );
  await act(async () => button.props.onClick());
}

async function clickButton(instance: any, label: string) {
  await clickIn(instance, label);
}

async function openPanel(instance: ReactTestRenderer) {
  const button = instance.root.find(
    (n) => n.type === 'button' && n.props.title === 'Speakers'
  );
  await act(async () => button.props.onClick());
}

function speakerRow(instance: ReactTestRenderer, label: string) {
  return instance.root.find(
    (n) => n.props?.['data-testid'] === `speaker-row-${label}`
  );
}

async function typeName(instance: ReactTestRenderer, label: string, value: string) {
  const input = speakerRow(instance, label).find((n: any) => n.type === 'input');
  await act(async () => input.props.onChange({ target: { value } }));
}

function assignCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'api_assign_meeting_speakers');
}

function directoryCalls() {
  return invoke.mock.calls.filter(([command]) => command === 'api_get_speaker_names');
}

interface PickerOption {
  /** The option's own label, without the "which speaker holds it" hint. */
  text: string;
  /** The speaker that holds this name in the draft, when the option is blocked. */
  owner: string | null;
  /** cmdk marks a disabled item aria-disabled and drops its select handler. */
  disabled: boolean;
  className: string | undefined;
}

/**
 * The options of one row's name picker, in render order. The first button of a
 * row is the picker trigger; the rest are the "No name", "Create" and
 * directory entries.
 */
function pickerOptionEntries(
  instance: ReactTestRenderer,
  label: string,
): PickerOption[] {
  return speakerRow(instance, label)
    .findAll((n: any) => n.type === 'button')
    .slice(1)
    .map((button: any) => {
      const spans = button.findAll((n: any) => n.type === 'span');
      const owner = spans.find(
        (span: any) => span.props?.['data-testid'] === 'name-owner',
      );
      return {
        text: spans[0] ? instanceText(spans[0]) : instanceText(button),
        owner: owner ? instanceText(owner) : null,
        disabled:
          Boolean(button.props.disabled) ||
          button.props['aria-disabled'] === true ||
          button.props['aria-disabled'] === 'true',
        className: button.props.className,
      };
    });
}

/** The option labels of one row's name picker, in render order. */
function pickerOptions(instance: ReactTestRenderer, label: string): string[] {
  return pickerOptionEntries(instance, label).map((option) => option.text);
}

test('rows show the Speaker N placeholder, segment count and current name', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 12,
      first_start_time: 0,
    },
    {
      label: 'speaker_1',
      speaker_name: 'Maria',
      segment_count: 1,
      first_start_time: 30,
    },
  ];

  const instance = await render();
  await openPanel(instance);
  const rendered = text(instance);

  expect(rendered).toContain('Speaker 1');
  expect(rendered).toContain('Speaker 2');
  expect(rendered).toContain('12 segments');
  expect(rendered).toContain('1 segment');
  expect(rendered).toContain('Maria');
});

test('picking an existing directory name then Done sends the assignment', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 3,
      first_start_time: 0,
    },
  ];
  directory = ['Alex'];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'al');
  await clickButton(speakerRow(instance, 'speaker_0'), 'Alex');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_0', name: 'Alex' }] },
    ],
  ]);
  expect(onRefetchTranscripts).toHaveBeenCalled();
});

test('Done only sends the rows whose draft changed', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: 'Alex',
      segment_count: 3,
      first_start_time: 0,
    },
    {
      label: 'speaker_1',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 40,
    },
  ];
  directory = ['Alex', 'Maria'];

  const instance = await render();
  await openPanel(instance);
  await clickButton(speakerRow(instance, 'speaker_1'), 'Maria');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_1', name: 'Maria' }] },
    ],
  ]);
});

test('typing a new name offers Create and sends that name', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
  ];
  directory = [];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'Мария');
  expect(text(instance)).toContain('Create „Мария“');

  await clickButton(speakerRow(instance, 'speaker_0'), 'Create „Мария“');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_0', name: 'Мария' }] },
    ],
  ]);
});

test('an exact case-insensitive match does not offer Create', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
  ];
  directory = ['Alex'];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', '  aLeX ');

  const row = speakerRow(instance, 'speaker_0');
  expect(instanceText(row)).toContain('Alex');
  expect(text(instance)).not.toContain('Create „');
});

// --- Whole directory in the picker ---------------------------------------

test('the opened list offers the whole directory, sorted by the shared rule', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
  ];
  // Deliberately unordered and larger than the old eight-name cap.
  directory = [
    'Zoe',
    'Мария',
    'Alex',
    'анна',
    'Борис',
    '2B',
    'Иван',
    'Viktor',
    'Ольга',
    'Dan',
  ];

  const instance = await render();
  await openPanel(instance);

  expect(pickerOptions(instance, 'speaker_0')).toEqual([
    'No name',
    'анна',
    'Борис',
    'Иван',
    'Мария',
    'Ольга',
    'Alex',
    'Dan',
    'Viktor',
    'Zoe',
    '2B',
  ]);
});

test('the directory is read once per panel open, not once per speaker row', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
    { label: 'speaker_2', speaker_name: null, segment_count: 1, first_start_time: 40 },
  ];
  directory = ['Alex', 'Мария'];

  const instance = await render();
  await openPanel(instance);

  expect(directoryCalls().map(([command]) => command)).toEqual(['api_get_speaker_names']);
});

test('typing filters locally, in the same alphabetical order, with no request', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
  ];
  directory = ['Мария', 'Максим', 'Alex', 'анна', 'Zoe'];

  const instance = await render();
  await openPanel(instance);
  invoke.mockClear();

  await typeName(instance, 'speaker_0', 'ма');

  expect(directoryCalls()).toEqual([]);
  expect(pickerOptions(instance, 'speaker_0')).toEqual([
    'No name',
    'Create „ма“',
    'Максим',
    'Мария',
  ]);
});

test('filtering is case-insensitive for Cyrillic and Latin alike', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
  ];
  directory = ['Мария', 'Alex'];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'МАРИЯ');
  expect(pickerOptions(instance, 'speaker_0')).toEqual(['No name', 'Мария']);

  await typeName(instance, 'speaker_0', 'AL');
  expect(pickerOptions(instance, 'speaker_0')).toEqual(['No name', 'Create „AL“', 'Alex']);
});

test('an unreadable directory keeps No name and Create, and says so inside the list', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
  ];
  directoryError = 'database is locked';

  const instance = await render();
  await openPanel(instance);

  const options = pickerOptions(instance, 'speaker_0');
  expect(options[0]).toBe('No name');
  expect(instanceText(speakerRow(instance, 'speaker_0'))).toContain(
    'Could not read the people directory.',
  );
  // The raw backend string is a diagnostic, not something to show a user.
  expect(instanceText(speakerRow(instance, 'speaker_0'))).not.toContain('database is locked');
  expect(text(instance)).not.toContain('Create „');

  // Removing the name still works: a broken read is not a broken panel.
  await clickButton(speakerRow(instance, 'speaker_0'), 'No name');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_0', name: null }] },
    ],
  ]);
});

test('a broken directory still allows creating a new person from what was typed', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
  ];
  directoryError = 'database is locked';

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'Ghost');
  await clickButton(speakerRow(instance, 'speaker_0'), 'Create „Ghost“');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_0', name: 'Ghost' }] },
    ],
  ]);
});

test('a saved name is in the list on the next open, because the directory is re-read', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: null, segment_count: 2, first_start_time: 0 },
  ];
  directory = [];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'Мария');
  await clickButton(speakerRow(instance, 'speaker_0'), 'Create „Мария“');

  // Saving creates the person; a later open must show it without typing.
  speakers = [
    { label: 'speaker_0', speaker_name: 'Мария', segment_count: 2, first_start_time: 0 },
  ];
  directory = ['Мария'];
  await clickButton(instance, 'Done');
  await openPanel(instance);

  expect(directoryCalls().length).toBe(3);
  expect(pickerOptions(instance, 'speaker_0')).toEqual(['No name', 'Мария']);
});

// --- Names already taken by another speaker ------------------------------

test('a name assigned to another speaker is listed but not selectable, and names its owner', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Alex', 'Zoe'];

  const instance = await render();
  await openPanel(instance);

  const alex = pickerOptionEntries(instance, 'speaker_1').find((option) =>
    option.text.includes('Alex'),
  );

  // Still listed, genuinely non-selectable, and it says who holds the name.
  expect(alex).toBeDefined();
  expect(alex!.disabled).toBeTrue();
  expect(alex!.owner).toBe('Speaker 1');

  // Disabled means disabled: clicking it changes nothing on Done.
  await clickButton(speakerRow(instance, 'speaker_1'), 'Alex');
  await clickButton(instance, 'Done');
  expect(assignCalls()).toHaveLength(0);
});

test('an unavailable name is visually distinct from an available one', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Alex', 'Zoe'];

  const instance = await render();
  await openPanel(instance);

  const options = pickerOptionEntries(instance, 'speaker_1');
  const alex = options.find((option) => option.text.includes('Alex'))!;
  const zoe = options.find((option) => option.text.includes('Zoe'))!;

  // The unavailable row is greyed out; the available one is not.
  expect(alex.className).not.toBe(zoe.className);
  expect(String(alex.className)).toContain('opacity-50');
  expect(String(zoe.className ?? '')).not.toContain('opacity-50');
});

test('the speaker that owns a name in the draft keeps it selectable', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Alex', 'Zoe'];

  const instance = await render();
  await openPanel(instance);

  const own = pickerOptionEntries(instance, 'speaker_0').find((option) =>
    option.text.includes('Alex'),
  );
  expect(own!.disabled).toBeFalse();
  expect(own!.owner).toBeNull();
});

test('a name can be handed over between two rows of the draft', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Alex', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Alex', 'Zoe'];

  const instance = await render();
  await openPanel(instance);

  const blockedFor = (label: string) =>
    pickerOptionEntries(instance, label).find((option) =>
      option.text.includes('Alex'),
    )!.disabled;

  expect(blockedFor('speaker_1')).toBeTrue();

  // Ownership follows the draft, not only what was saved: once speaker_0 lets
  // the name go, speaker_1 may take it. A swap is one batch.
  await clickButton(speakerRow(instance, 'speaker_0'), 'Zoe');
  expect(blockedFor('speaker_1')).toBeFalse();

  await clickButton(speakerRow(instance, 'speaker_1'), 'Alex');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      {
        meetingId: 'meeting-a',
        assignments: [
          { label: 'speaker_0', name: 'Zoe' },
          { label: 'speaker_1', name: 'Alex' },
        ],
      },
    ],
  ]);
});

test('blocked names still filter and keep the alphabetical order', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: 'Мария', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Мария', 'Максим', 'Alex', 'анна'];

  const instance = await render();
  await openPanel(instance);

  expect(pickerOptions(instance, 'speaker_1')).toEqual([
    'No name',
    'анна',
    'Максим',
    'Мария',
    'Alex',
  ]);
  const blocked = (option: { text: string }) => option.text.includes('Мария');

  await typeName(instance, 'speaker_1', 'ма');
  expect(pickerOptions(instance, 'speaker_1')).toEqual([
    'No name',
    'Create „ма“',
    'Максим',
    'Мария',
  ]);
  expect(
    pickerOptionEntries(instance, 'speaker_1').filter(blocked)[0]!.disabled,
  ).toBeTrue();
});

test('occupancy ignores case and surrounding whitespace, including Cyrillic', async () => {
  speakers = [
    { label: 'speaker_0', speaker_name: '  АЛЕКС ', segment_count: 2, first_start_time: 0 },
    { label: 'speaker_1', speaker_name: null, segment_count: 1, first_start_time: 20 },
  ];
  directory = ['Алекс', 'Zoe'];

  const instance = await render();
  await openPanel(instance);

  const alex = pickerOptionEntries(instance, 'speaker_1').find((option) =>
    option.text.includes('Алекс'),
  );
  expect(alex!.disabled).toBeTrue();
});

test('No name is sent as null', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: 'Alex',
      segment_count: 2,
      first_start_time: 0,
    },
  ];
  directory = ['Alex'];

  const instance = await render();
  await openPanel(instance);

  await clickButton(speakerRow(instance, 'speaker_0'), 'No name');
  await clickButton(instance, 'Done');

  expect(assignCalls()).toEqual([
    [
      'api_assign_meeting_speakers',
      { meetingId: 'meeting-a', assignments: [{ label: 'speaker_0', name: null }] },
    ],
  ]);
});

test('dismissing the sheet (Escape / outside click) discards the draft', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
  ];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'Ghost');
  await clickButton(speakerRow(instance, 'speaker_0'), 'Create „Ghost“');

  await act(async () => sheetOnOpenChange?.(false));

  expect(assignCalls()).toHaveLength(0);
  expect(nodeText(instance.toJSON())).not.toContain('Ghost');
});

test('Cancel discards the draft without calling the backend', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
  ];

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_0', 'Ghost');
  await clickButton(speakerRow(instance, 'speaker_0'), 'Create „Ghost“');
  await clickButton(instance, 'Cancel');

  expect(assignCalls()).toHaveLength(0);

  // Reopening reloads the panel from the backend, so the discarded draft is gone.
  await openPanel(instance);
  expect(text(instance)).not.toContain('Ghost');
  expect(text(instance)).toContain('No name');
});

test('empty panel shows the diarization hint', async () => {
  speakers = [];

  const instance = await render();
  await openPanel(instance);

  const en = (await import('../../src/i18n/locales/en/translation.json')).default;
  // No diarization model installed: the panel states the download sentence
  // (the frontend catalog is the single source, native-i18n spec D8).
  expect(text(instance)).toContain(en.speakers.failures.unavailable);
});

// --- Manual diarization from the panel ------------------------------------

function diarizeButton(instance: ReactTestRenderer) {
  return instance.root.find(
    (n) => n.props?.['data-testid'] === 'diarize-meeting-button',
  );
}

test('the empty state keeps the hint and offers a manual run button', async () => {
  speakers = [];
  availableModels = [diarizationModel()];

  const instance = await renderPanel();

  const en = (await import('../../src/i18n/locales/en/translation.json')).default;
  expect(text(instance)).toContain(en.speakers.hints.noModel);
  expect(diarizeButton(instance)).toBeDefined();
});

test('without a diarization model the button is disabled and explains why', async () => {
  speakers = [];
  // A catalog entry that is not the diarization model: the install check must
  // not mistake it for Nemotron. (A pre-migration ASR entry, hence the cast.)
  availableModels = [diarizationModel({ name: 'gigaam', task: 'asr' as unknown as 'diar' })];

  const instance = await renderPanel();

  const button = diarizeButton(instance);
  expect(button.props.disabled).toBeTrue();
  expect(String(button.props.title)).toContain('Download the Nemotron-3-Diarization model');

  await act(async () => button.props.onClick());
  expect(diarizeMeeting).not.toHaveBeenCalled();
});

test('a catalog that cannot be read keeps the button usable and says why it is unknown', async () => {
  // A failed catalog read is not knowledge: the panel must not pretend the
  // model is missing and lock the button forever. The manual run is the user's
  // way to find out, and native code reports the real reason.
  speakers = [];
  modelListError = 'catalog unavailable';

  const instance = await renderPanel();

  const button = diarizeButton(instance);
  expect(button.props.disabled).toBeFalse();
  expect(text(instance)).toContain('Could not read the diarization model list');

  await act(async () => button.props.onClick());
  expect(diarizeMeeting.mock.calls).toEqual([['meeting-a']]);
});

test('with an installed model the button is enabled and runs the pass', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  diarizationStep = async () => diarizationResult('ran');

  const instance = await renderPanel();

  const button = diarizeButton(instance);
  expect(button.props.disabled).toBeFalse();

  await act(async () => button.props.onClick());
  expect(diarizeMeeting.mock.calls).toEqual([['meeting-a']]);
});

test('a running pass shows progress and refuses a second concurrent run', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  let finish!: (result: DiarizationResult) => void;
  diarizationStep = () => new Promise<DiarizationResult>((resolve) => { finish = resolve; });

  const instance = await renderPanel();
  await act(async () => {
    void diarizeButton(instance).props.onClick();
  });

  // In-panel progress instead of a toast the user may miss.
  expect(text(instance)).toContain('Running diarization');

  const during = diarizeButton(instance);
  expect(during.props.disabled).toBeTrue();
  await act(async () => {
    void during.props.onClick();
  });
  expect(diarizeMeeting).toHaveBeenCalledTimes(1);

  await act(async () => finish(diarizationResult('deferred')));
  expect(diarizeMeeting).toHaveBeenCalledTimes(1);
});

test('a successful run reloads the speaker list', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  diarizationStep = async () => {
    // The pass writes labels to the database; the follow-up read returns them.
    speakers = [
      {
        label: 'speaker_0',
        speaker_name: null,
        segment_count: 2,
        first_start_time: 0,
      },
    ];
    return diarizationResult('ran');
  };

  const instance = await renderPanel();
  invoke.mockClear();

  await act(async () => diarizeButton(instance).props.onClick());

  expect(
    invoke.mock.calls.filter(([command]) => command === 'api_get_meeting_speakers'),
  ).toHaveLength(1);
  expect(text(instance)).toContain('Speaker 1');
  expect(onRefetchTranscripts).toHaveBeenCalled();
});

test('a refused run explains the reason in the panel and keeps the button usable', async () => {
  for (const [status, expected] of [
    ['no_model', 'Download the Nemotron-3-Diarization model'],
    ['no_runtime', 'The audio.cpp engine is unavailable'],
    ['deferred', 'a recording is in progress'],
    ['failed', 'because diarization failed'],
  ] as const) {
    speakers = [];
    availableModels = [diarizationModel()];
    diarizationStep = async () => diarizationResult(status);

    if (renderer) await act(async () => renderer!.unmount());
    const instance = await renderPanel();
    await act(async () => diarizeButton(instance).props.onClick());

    expect(text(instance)).toContain(expected);
    expect(diarizeButton(instance).props.disabled).toBeFalse();
    expect(text(instance)).not.toContain('Running diarization');
  }
});

test('a rejected command reports the failure instead of leaving an empty panel', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  diarizationStep = async () => { throw new Error('backend went away'); };

  const instance = await renderPanel();
  await act(async () => diarizeButton(instance).props.onClick());

  expect(text(instance)).toContain('backend went away');
  expect(diarizeButton(instance).props.disabled).toBeFalse();
});

test('a failed pass shows its diagnostic detail next to the reason', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  diarizationStep = async () =>
    diarizationResult('failed', { error: 'engine exploded' });

  const instance = await renderPanel();
  await act(async () => diarizeButton(instance).props.onClick());

  const reason = instance.root.find(
    (n) => n.props?.['data-testid'] === 'diarization-reason',
  );
  expect(instanceText(reason)).toContain('because diarization failed');
  expect(instanceText(reason)).toContain('engine exploded');
});

test('a pass that labeled nothing explains the empty list', async () => {
  speakers = [];
  availableModels = [diarizationModel()];
  diarizationStep = async () =>
    diarizationResult('ran', { labeled_segments: 0, total_segments: 2 });

  const instance = await renderPanel();
  await act(async () => diarizeButton(instance).props.onClick());

  expect(text(instance)).toContain('found no distinct speakers');
});

test('the manual run does not toast: the panel itself answers the action', async () => {
  for (const status of ['ran', 'no_model', 'no_runtime', 'deferred', 'failed'] as const) {
    speakers = [];
    availableModels = [diarizationModel()];
    diarizationStep = async () => diarizationResult(status);

    if (renderer) await act(async () => renderer!.unmount());
    const instance = await renderPanel();
    await act(async () => diarizeButton(instance).props.onClick());
  }

  expect(notify).not.toHaveBeenCalled();
});

test('a conflict lands on the edited row, not on the speaker number from the message', async () => {
  // The backend says "already assigned to Speaker 1", but the row the user
  // edited in this batch is the second one. The message must land there.
  //
  // The conflict is staged by typing a name the directory does not list (so
  // the picker cannot block it beforehand) in a different case than the saved
  // name: the backend still rejects the pair, and the panel must place its
  // message on the row the user edited.
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: 'Alex',
      segment_count: 2,
      first_start_time: 0,
    },
    {
      label: 'speaker_1',
      speaker_name: null,
      segment_count: 1,
      first_start_time: 20,
    },
  ];
  directory = [];
  assignError = 'this person is already assigned to Speaker 1';

  const instance = await render();
  await openPanel(instance);

  await typeName(instance, 'speaker_1', '  aLeX ');
  await clickButton(speakerRow(instance, 'speaker_1'), 'Create „aLeX“');
  await clickButton(instance, 'Done');

  const edited = instanceText(speakerRow(instance, 'speaker_1'));
  expect(edited).toContain('this person is already assigned to Speaker 1');
  expect(instanceText(speakerRow(instance, 'speaker_0'))).not.toContain(
    'already assigned',
  );
});

test('a conflict between two newly typed names lands on the edited row', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
    {
      label: 'speaker_1',
      speaker_name: null,
      segment_count: 1,
      first_start_time: 20,
    },
  ];
  directory = [];
  assignError = 'this person is already assigned to Speaker 1';

  const instance = await render();
  await openPanel(instance);

  for (const [label, name] of [
    ['speaker_0', 'Maria'],
    ['speaker_1', ' maria '],
  ] as const) {
    await typeName(instance, label, name);
      await clickButton(speakerRow(instance, label), `Create „${name.trim()}“`);
  }
  await clickButton(instance, 'Done');

  const rendered = text(instance);
  expect(rendered).toContain('this person is already assigned to Speaker 1');
  expect(instanceText(speakerRow(instance, 'speaker_1'))).toContain('already assigned');
});

test('a backend conflict keeps the panel open and shows the message on the row', async () => {
  speakers = [
    {
      label: 'speaker_0',
      speaker_name: null,
      segment_count: 2,
      first_start_time: 0,
    },
    {
      label: 'speaker_1',
      speaker_name: null,
      segment_count: 1,
      first_start_time: 20,
    },
  ];
  directory = ['Alex'];
  assignError = 'this person is already assigned to Speaker 1';

  const instance = await render();
  await openPanel(instance);

  for (const label of ['speaker_0', 'speaker_1']) {
    await typeName(instance, label, 'al');
      await clickButton(speakerRow(instance, label), 'Alex');
  }

  await clickButton(instance, 'Done');

  const rendered = text(instance);
  expect(rendered).toContain('this person is already assigned to Speaker 1');
  expect(rendered).toContain('Done');
  expect(onRefetchTranscripts).not.toHaveBeenCalled();
});
