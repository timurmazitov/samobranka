/**
 * The meeting page's "a diarization pass is running" read: the same shared
 * pass store the speakers panel gates its buttons on. These tests drive the
 * store through a fake bridge and assert what the hook reports for one
 * meeting, so the transcript edit gate provably reads the panel's truth.
 */

import React from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

const { DiarizationPassStore } = await import('../../src/lib/diarization');
const { useDiarizationPassRunning } = await import(
  '../../src/hooks/useDiarizationPassRunning'
);

/** The fake bridge injected into the seam store (speakers-panel pattern). */
function fakeListen() {
  const registered = new Map<string, (event: { payload: never }) => void>();
  const listen = async (name: string, handler: (event: { payload: never }) => void) => {
    registered.set(name, handler);
    return () => {
      registered.delete(name);
    };
  };
  return { registered, listen };
}

let latest: boolean | null = null;
let renderer: ReactTestRenderer | undefined;

function Probe({
  meetingId,
  passStore,
}: {
  meetingId?: string;
  passStore: InstanceType<typeof DiarizationPassStore>;
}) {
  latest = useDiarizationPassRunning(meetingId, passStore);
  return null;
}

async function renderProbe(
  meetingId: string | undefined,
  passStore: InstanceType<typeof DiarizationPassStore>,
) {
  latest = null;
  await act(async () => {
    renderer = create(<Probe meetingId={meetingId} passStore={passStore} />);
  });
  await passStore.settled();
}

async function emitProgress(
  bridge: ReturnType<typeof fakeListen>,
  payload: Record<string, unknown>,
) {
  const handler = bridge.registered.get('diarization-progress');
  expect(handler, 'listener for diarization-progress').toBeDefined();
  act(() => {
    handler!({ payload } as never);
  });
  await Promise.resolve();
}

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
});

beforeEach(() => {
  latest = null;
});

test('no known pass means not running', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe('meeting-a', store);

  expect(latest).toBeFalse();
});

test('a running pass for this meeting reads as running', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe('meeting-a', store);
  await emitProgress(bridge, { meeting_id: 'meeting-a', stage: 'inferring' });

  expect(latest).toBeTrue();
});

test("another meeting's pass does not gate this meeting", async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe('meeting-a', store);
  await emitProgress(bridge, { meeting_id: 'meeting-b', stage: 'inferring' });

  expect(latest).toBeFalse();
});

test('the terminal clears the running read', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe('meeting-a', store);
  await emitProgress(bridge, { meeting_id: 'meeting-a', stage: 'inferring' });
  expect(latest).toBeTrue();

  const terminal = bridge.registered.get('transcript-updated');
  expect(terminal, 'listener for transcript-updated').toBeDefined();
  act(() => {
    terminal!({
      payload: { meeting_id: 'meeting-a', labeled_segments: 2, total_segments: 2 },
    } as never);
  });
  await Promise.resolve();

  expect(latest).toBeFalse();
});

test('a failed pass is not running: editing may continue', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe('meeting-a', store);
  await emitProgress(bridge, { meeting_id: 'meeting-a', stage: 'inferring' });

  const failed = bridge.registered.get('diarization-unavailable');
  expect(failed, 'listener for diarization-unavailable').toBeDefined();
  act(() => {
    failed!({
      payload: { meeting_id: 'meeting-a', status: 'failed' },
    } as never);
  });
  await Promise.resolve();

  expect(latest).toBeFalse();
});

test('without a meeting id there is nothing to gate', async () => {
  const bridge = fakeListen();
  const store = new DiarizationPassStore(bridge.listen as never);

  await renderProbe(undefined, store);
  await emitProgress(bridge, { meeting_id: 'meeting-a', stage: 'inferring' });

  expect(latest).toBeFalse();
});
