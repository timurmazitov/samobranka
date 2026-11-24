import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

// The retranscription gate that closes segment deletion while the transcript
// is being rewritten from the audio. The native event bridge and the state
// probe are injected through the hook's seams (same idea as the names-reset
// listener's `listenImpl`), so no module-level Tauri mock leaks into other
// suites.

import {
  useRetranscriptionRunning,
  type RetranscriptionInvoke,
} from '../../src/hooks/useRetranscriptionRunning';

type Handler = (event: { payload: { meeting_id?: string } }) => void;

function fakeBridge(seed: boolean) {
  const registered = new Map<string, Handler>();
  const unlistened = mock((name: string) => {});
  const listen = async (name: string, handler: Handler) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
      unlistened(name);
    };
  };
  const invoke = mock(async (command: string): Promise<unknown> => {
    if (command === 'is_retranscription_in_progress_command') return seed;
    throw new Error(`Unexpected command: ${command}`);
  }) as unknown as RetranscriptionInvoke & { mock: { calls: unknown[][] } };
  return { registered, unlistened, listen, invoke };
}

let renderer: ReactTestRenderer | undefined;
let gate: boolean;
let bridge = fakeBridge(false);

function Harness({ meetingId }: { meetingId: string | null }) {
  gate = useRetranscriptionRunning(meetingId, bridge.listen, bridge.invoke);
  return <span>{String(gate)}</span>;
}

async function show(meetingId: string | null = 'meeting-a') {
  await act(async () => { renderer = create(<Harness meetingId={meetingId} />); });
}

async function emit(event: string, payload: { meeting_id?: string }) {
  const handler = bridge.registered.get(event);
  expect(handler).toBeDefined();
  await act(async () => { handler!({ payload }); });
}

beforeEach(() => {
  bridge = fakeBridge(false);
});

afterEach(async () => {
  if (renderer) await act(async () => { renderer!.unmount(); });
  renderer = undefined;
});

describe('retranscription running gate', () => {
  test('the gate opens on a progress event for the open meeting', async () => {
    await show('meeting-a');

    await emit('retranscription-progress', { meeting_id: 'meeting-a' });

    expect(gate).toBe(true);
  });

  test('the gate closes when the run completes', async () => {
    await show('meeting-a');
    await emit('retranscription-progress', { meeting_id: 'meeting-a' });
    expect(gate).toBe(true);

    await emit('retranscription-complete', { meeting_id: 'meeting-a' });

    expect(gate).toBe(false);
  });

  test('the gate closes on a run error', async () => {
    await show('meeting-a');
    await emit('retranscription-progress', { meeting_id: 'meeting-a' });

    await emit('retranscription-error', { meeting_id: 'meeting-a' });

    expect(gate).toBe(false);
  });

  test('a run of another meeting never opens the gate', async () => {
    await show('meeting-a');

    await emit('retranscription-progress', { meeting_id: 'meeting-b' });

    expect(gate).toBe(false);
  });

  test('a terminal event of another meeting still clears the gate', async () => {
    // The native flag is global: one app-wide run at a time. A complete for
    // any meeting ends the only run, so a gate opened for the open meeting
    // must clear even when the event names the other meeting.
    await show('meeting-a');
    await emit('retranscription-progress', { meeting_id: 'meeting-a' });
    expect(gate).toBe(true);

    await emit('retranscription-complete', { meeting_id: 'meeting-b' });

    expect(gate).toBe(false);
  });

  test('a run already going when the page mounts opens the gate from the seed read', async () => {
    // The dialog may be closed and the page remounted mid-run: the first
    // render must already block deletion, not wait for the next event.
    bridge = fakeBridge(true);
    await show('meeting-a');

    expect(bridge.invoke).toHaveBeenCalledWith('is_retranscription_in_progress_command');
    expect(gate).toBe(true);
  });

  test('a failed seed read leaves the gate open', async () => {
    // An honest failure of the probe must not freeze the page — the same rule
    // as a `failed` diarization phase.
    const failingInvoke = mock(async (_command: string): Promise<unknown> => {
      throw new Error('probe unavailable');
    }) as unknown as RetranscriptionInvoke;
    function FailingHarness() {
      gate = useRetranscriptionRunning('meeting-a', fakeBridge(false).listen, failingInvoke);
      return <span />;
    }
    await act(async () => { renderer = create(<FailingHarness />); });

    expect(gate).toBe(false);
    expect(failingInvoke).toHaveBeenCalledWith('is_retranscription_in_progress_command');
  });

  test('the listeners are removed on unmount', async () => {
    await show('meeting-a');
    expect(bridge.registered.has('retranscription-progress')).toBe(true);

    await act(async () => { renderer!.unmount(); });
    renderer = undefined;

    expect(bridge.registered.has('retranscription-progress')).toBe(false);
    expect(bridge.unlistened).toHaveBeenCalledWith('retranscription-progress');
  });
});
