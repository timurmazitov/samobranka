import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The «Выделение» toggle (ticket 02) joins the transcript panel's button
// group next to Find. The Speakers panel / Retranscribe dialog behind the
// group are inert here: they open only on their own buttons, and this suite
// drives only the selection toggle. Toasts are captured so the sonner module
// stays inert like the other MeetingDetails component suites.

const errorNotify = mock((..._args: unknown[]) => {});
mock.module('sonner', () => ({
  toast: { success: mock(), error: errorNotify, info: mock(), warning: mock() },
}));

const originalConfig = { ...(await import('../../src/contexts/ConfigContext')) };
mock.module('../../src/contexts/ConfigContext', () => ({
  useConfig: () => ({
    selectedLanguage: 'auto',
    transcriptModelConfig: { provider: 'whisper', model: 'large-v3' },
  }),
}));

// The group's Export dropdown is Radix-based and needs a DOM; this suite
// drives only the selection toggle, so the menu wrappers become plain
// containers (re-registered in beforeEach like the config mock).
const Container = ({ children }: any) => <div>{children}</div>;
const dropdownMenuMock = () => ({
  DropdownMenu: Container,
  DropdownMenuTrigger: Container,
  DropdownMenuContent: Container,
  DropdownMenuItem: Container,
});
const originalDropdownMenu = { ...await import('../../src/components/ui/dropdown-menu') };
mock.module('../../src/components/ui/dropdown-menu', dropdownMenuMock);
afterAll(() => {
  mock.module('../../src/components/ui/dropdown-menu', () => originalDropdownMenu);
});

const { TranscriptButtonGroup } = await import(
  '../../src/components/MeetingDetails/TranscriptButtonGroup'
);
type GroupProps = import('../../src/components/MeetingDetails/TranscriptButtonGroup').TranscriptButtonGroupProps;

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  mock.module('../../src/contexts/ConfigContext', () => ({
    useConfig: () => ({
      selectedLanguage: 'auto',
      transcriptModelConfig: { provider: 'whisper', model: 'large-v3' },
    }),
  }));
  mock.module('../../src/components/ui/dropdown-menu', dropdownMenuMock);
  errorNotify.mockClear();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

async function render(props: Partial<GroupProps> = {}) {
  await act(async () => {
    renderer = create(
      <TranscriptButtonGroup
        transcriptCount={3}
        onCopyTranscript={() => {}}
        onExportTranscript={() => {}}
        onOpenMeetingFolder={async () => {}}
        meetingId="meeting-a"
        meetingFolderPath="/tmp/meeting-a"
        {...props}
      />,
    );
  });
  return renderer!;
}

function selectionButton(instance: ReactTestRenderer) {
  return instance.root.findAll(
    n => n.type === 'button' && n.props.title === 'Select speech segments',
  )[0];
}

describe('the «Выделение» toggle in the transcript button group', () => {
  test('the button toggles the selection mode through the host', async () => {
    const toggle = mock(() => {});
    const view = await render({ onToggleSelection: toggle });

    const button = selectionButton(view);
    expect(button).toBeDefined();

    await act(async () => { button.props.onClick(); });
    expect(toggle.mock.calls).toEqual([[]]);
  });

  test('without a selection host (live page) there is no toggle button', async () => {
    const view = await render();
    expect(selectionButton(view)).toBeUndefined();
  });

  test('the button reads as active while the mode is on', async () => {
    const view = await render({ onToggleSelection: () => {}, selectionMode: true });
    const button = selectionButton(view);
    // Active = not the outline variant every other button in the group uses.
    expect(button.props.variant).not.toBe('outline');
  });

  test('recording, diarization and retranscription disable the toggle', async () => {
    for (const blocker of [
      { isRecording: true },
      { isDiarizing: true },
      { isRetranscribing: true },
    ]) {
      const view = await render({ onToggleSelection: () => {}, ...blocker });
      const button = selectionButton(view);
      expect(button).toBeDefined();
      expect(button.props.disabled).toBe(true);
    }
  });
});
