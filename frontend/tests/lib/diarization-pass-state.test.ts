/**
 * The shared diarization pass state — the single source every surface reads
 * (speakers panel, import/retranscription dialogs, live stop).
 *
 * Tests drive the pure reducer with fake `diarization-progress` payloads and
 * feed the same payloads into the store with fake terminal events, so the
 * contract pinned here is what the frontend sees on the Tauri channel:
 * stage transitions, honest percentages (absent on indeterminate stages),
 * and terminals that end the pass.
 */

import { describe, expect, test } from 'bun:test';

import {
  DIARIZATION_STAGES,
  DiarizationPassStore,
  applyDiarizationFailure,
  applyDiarizationProgress,
  type DiarizationPassState,
  type DiarizationProgressPayload,
} from '../../src/lib/diarization';

function progress(
  overrides: Partial<DiarizationProgressPayload> = {},
): DiarizationProgressPayload {
  return {
    meeting_id: 'meeting-a',
    stage: 'decoding',
    message: 'Analyzing the audio...',
    ...overrides,
  };
}

describe('applyDiarizationProgress (pure reducer)', () => {
  test('the first stage starts the pass', () => {
    const next = applyDiarizationProgress(null, progress({ stage: 'queued' }));

    expect(next).toEqual({
      meetingId: 'meeting-a',
      stage: 'queued',
      progressPercentage: null,
      message: 'Analyzing the audio...',
      phase: 'running',
      error: null,
    } satisfies DiarizationPassState);
  });

  test('stages advance in the pass order', () => {
    const script: Array<Pick<DiarizationProgressPayload, 'stage' | 'progress_percentage'>> = [
      { stage: 'queued' },
      { stage: 'loading_model', progress_percentage: 0 },
      { stage: 'loading_model', progress_percentage: 100 },
      { stage: 'decoding' },
      { stage: 'inferring' },
      { stage: 'applying_labels', progress_percentage: 0 },
      { stage: 'applying_labels', progress_percentage: 100 },
    ];

    let state: DiarizationPassState | null = null;
    for (const payload of script) {
      state = applyDiarizationProgress(state, progress(payload));
      expect(state).not.toBeNull();
    }
    expect(state?.stage).toBe('applying_labels');
    expect(state?.progressPercentage).toBe(100);
  });

  test('a missing percentage reads as indeterminate, not zero', () => {
    const state = applyDiarizationProgress(null, progress({ stage: 'inferring' }));

    expect(state?.progressPercentage).toBeNull();
  });

  test('an explicit null percentage is indeterminate too', () => {
    // The native payload omits the key on indeterminate stages; a defensive
    // explicit null must not become "0 percent" on screen.
    const state = applyDiarizationProgress(null, progress({ stage: 'inferring', progress_percentage: null }));

    expect(state?.progressPercentage).toBeNull();
  });

  test('a percentage outside zero to hundred is not trusted', () => {
    expect(
      applyDiarizationProgress(null, progress({ stage: 'loading_model', progress_percentage: 101 }))
        ?.progressPercentage,
    ).toBeNull();
    expect(
      applyDiarizationProgress(null, progress({ stage: 'loading_model', progress_percentage: -1 }))
        ?.progressPercentage,
    ).toBeNull();
    expect(
      applyDiarizationProgress(null, progress({ stage: 'loading_model', progress_percentage: 42 }))
        ?.progressPercentage,
    ).toBe(42);
  });

  test('an unknown stage is not an attribution of work and changes nothing', () => {
    const current = applyDiarizationProgress(null, progress({ stage: 'queued' }));

    expect(applyDiarizationProgress(current, progress({ stage: 'transcribing' as never }))).toBe(
      current,
    );
  });

  test('an event without a meeting id cannot be attributed and changes nothing', () => {
    const current = applyDiarizationProgress(null, progress({ stage: 'queued' }));
    const orphan: DiarizationProgressPayload = { stage: 'decoding', message: 'x' };

    expect(applyDiarizationProgress(null, orphan)).toBeNull();
    expect(applyDiarizationProgress(current, orphan)).toBe(current);
  });
});

describe('applyDiarizationFailure (pure reducer)', () => {
  function failure(overrides: Record<string, unknown> = {}) {
    return {
      meeting_id: 'meeting-a',
      status: 'failed',
      ...overrides,
    } as Parameters<typeof applyDiarizationFailure>[1];
  }

  test('a failed terminal turns a running pass into an honest error', () => {
    const running = applyDiarizationProgress(null, progress({ stage: 'inferring' }));
    const next = applyDiarizationFailure(running, failure({ reason: 'engine exploded' }));

    expect(next).toEqual({
      meetingId: 'meeting-a',
      stage: null,
      progressPercentage: null,
      message: null,
      phase: 'failed',
      error: 'engine exploded',
    } satisfies DiarizationPassState);
  });

  test('a failure carries the native message when there is no reason', () => {
    const next = applyDiarizationFailure(
      applyDiarizationProgress(null, progress({ stage: 'decoding' })),
      failure({ message: 'Speaker labels were skipped because diarization failed.' }),
    );

    expect(next?.error).toBe('Speaker labels were skipped because diarization failed.');
  });

  test('a failure with neither reason nor message keeps the pass failed but reasonless', () => {
    const next = applyDiarizationFailure(
      applyDiarizationProgress(null, progress({ stage: 'decoding' })),
      failure(),
    );

    expect(next?.phase).toBe('failed');
    expect(next?.error).toBeNull();
  });

  test('a failed terminal can arrive with no prior stage and still show', () => {
    // The manual run's own command result can report a failure before any
    // progress stage was announced; the indicator must still appear.
    const next = applyDiarizationFailure(null, failure({ reason: 'boom' }));

    expect(next).toMatchObject({ meetingId: 'meeting-a', phase: 'failed', error: 'boom' });
  });

  test('a configuration reason is not a pass failure and changes nothing', () => {
    const running = applyDiarizationProgress(null, progress({ stage: 'decoding' }));
    for (const status of ['no_model', 'no_runtime', 'deferred', 'ran']) {
      expect(applyDiarizationFailure(running, failure({ status }))).toBe(running);
    }
  });

  test('a failure for another meeting never touches this pass', () => {
    const running = applyDiarizationProgress(null, progress({ stage: 'decoding' }));
    expect(applyDiarizationFailure(running, failure({ meeting_id: 'meeting-b' }))).toBe(running);
  });

  test('an id-less failure cannot be attributed', () => {
    const running = applyDiarizationProgress(null, progress({ stage: 'decoding' }));
    expect(applyDiarizationFailure(running, { status: 'failed' } as never)).toBe(running);
  });
});

describe('DiarizationPassStore', () => {
  function harness() {
    const registered = new Map<
      string,
      (event: { payload: Record<string, unknown> }) => void
    >();
    const unlistened: string[] = [];
    const listen = async (
      name: string,
      handler: (event: { payload: Record<string, unknown> }) => void,
    ) => {
      registered.set(name, handler);
      return () => {
        registered.delete(name);
        unlistened.push(name);
      };
    };
    return { registered, unlistened, listen };
  }

  function emit(
    bridge: ReturnType<typeof harness>,
    name: string,
    payload: Record<string, unknown> | DiarizationProgressPayload,
  ) {
    const handler = bridge.registered.get(name);
    if (!handler) throw new Error(`no listener for ${name}`);
    handler({ payload: payload as Record<string, unknown> });
  }

  test('one listener serves every subscriber and ends when they all leave', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);

    const stopA = store.subscribe();
    const stopB = store.subscribe();
    await store.settled();
    expect(bridge.registered.size).toBe(4); // progress + the three terminals

    const seen: Array<string | null> = [];
    const off = store.subscribe(() => seen.push(store.getState('meeting-a')?.stage ?? null));

    emit(bridge, 'diarization-progress', progress({ stage: 'inferring' }));
    expect(seen).toEqual(['inferring']);
    expect(store.getState('meeting-a')?.stage).toBe('inferring');

    off();
    stopA();
    expect(bridge.registered.size).toBe(4);
    stopB();
    expect(bridge.unlistened).toHaveLength(4);
    expect(bridge.registered.size).toBe(0);
  });

  test('a pass for another meeting never touches this meeting', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-progress', progress({ meeting_id: 'meeting-b', stage: 'queued' }));

    expect(store.getState('meeting-a')).toBeNull();
  });

  test('every terminal event for the meeting ends the pass', async () => {
    for (const terminal of [
      'transcript-updated',
      'diarization-unavailable',
      'speaker-names-reset',
    ]) {
      const bridge = harness();
      const store = new DiarizationPassStore(bridge.listen as never);
      store.subscribe();
      await store.settled();

      emit(bridge, 'diarization-progress', progress({ stage: 'inferring' }));
      expect(store.getState('meeting-a')?.stage).toBe('inferring');

      emit(bridge, terminal, { meeting_id: 'meeting-a' });
      expect(store.getState('meeting-a')).toBeNull();
      store.dispose();
    }
  });

  test('a failed terminal keeps the pass visible as an honest error', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.getState('meeting-a')?.phase ?? null));
    await store.settled();

    emit(bridge, 'diarization-progress', progress({ stage: 'inferring' }));
    emit(bridge, 'diarization-unavailable', {
      meeting_id: 'meeting-a',
      status: 'failed',
      reason: 'engine exploded',
      message: 'Speaker labels were skipped because diarization failed.',
    });

    expect(store.getState('meeting-a')).toEqual({
      meetingId: 'meeting-a',
      stage: null,
      progressPercentage: null,
      message: null,
      phase: 'failed',
      error: 'engine exploded',
    });
    expect(seen).toEqual(['running', 'failed']);
    store.dispose();
  });

  test('the first stage of a retry replaces the failed state', async () => {
    // The panel's "Retry" fires the same command again; when native code
    // announces its first stage, the error indicator gives way to the
    // spinner without the panel having to clear anything itself.
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-unavailable', { meeting_id: 'meeting-a', status: 'failed' });
    expect(store.getState('meeting-a')?.phase).toBe('failed');

    emit(bridge, 'diarization-progress', progress({ stage: 'queued' }));
    expect(store.getState('meeting-a')).toMatchObject({
      phase: 'running',
      stage: 'queued',
      error: null,
    });
    store.dispose();
  });

  test('an unavailable terminal without a failed status ends the pass like the others', async () => {
    // The native contract only sends `failed` here today; a payload with a
    // configuration status (or none) must not strand the indicator in a
    // half-state — the pass is over, the panel is empty again.
    for (const payload of [
      { meeting_id: 'meeting-a', status: 'deferred' },
      { meeting_id: 'meeting-a' },
    ]) {
      const bridge = harness();
      const store = new DiarizationPassStore(bridge.listen as never);
      store.subscribe();
      await store.settled();

      emit(bridge, 'diarization-progress', progress({ stage: 'inferring' }));
      emit(bridge, 'diarization-unavailable', payload);

      expect(store.getState('meeting-a')).toBeNull();
      store.dispose();
    }
  });

  test('a failed terminal for another meeting keeps this pass running', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-progress', progress({ stage: 'decoding' }));
    emit(bridge, 'diarization-unavailable', {
      meeting_id: 'meeting-b',
      status: 'failed',
      reason: 'engine exploded',
    });

    expect(store.getState('meeting-a')?.phase).toBe('running');
    store.dispose();
  });

  test('a terminal for another meeting keeps this pass visible', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-progress', progress({ stage: 'inferring' }));
    emit(bridge, 'transcript-updated', { meeting_id: 'meeting-b' });

    expect(store.getState('meeting-a')?.stage).toBe('inferring');
    store.dispose();
  });

  test('the manual run clears the pass when the command resolves', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-progress', progress({ stage: 'queued' }));
    store.clear('meeting-a');

    expect(store.getState('meeting-a')).toBeNull();
    store.dispose();
  });

  test('a missing event bridge does not break the store', async () => {
    const store = new DiarizationPassStore(
      (async () => {
        throw new Error('no bridge');
      }) as never,
    );
    const off = store.subscribe();

    await store.settled();

    expect(store.getState('meeting-a')).toBeNull();
    off();
  });

  test('a late bridge keeps listening after a first failure', async () => {
    // The same Tauri bridge can fail once (page load race) and work later;
    // a store that gave up would freeze the indicator on a stale stage.
    let attempts = 0;
    const registered = new Map<string, (event: { payload: unknown }) => void>();
    const listen = async (
      name: string,
      handler: (event: { payload: never }) => void,
    ) => {
      attempts += 1;
      if (attempts === 1) throw new Error('bridge not ready');
      registered.set(name, handler as never);
      return () => registered.delete(name);
    };
    const store = new DiarizationPassStore(listen as never);
    const off = store.subscribe();
    await store.settled();
    expect(store.isListening()).toBe(false);

    off();
    store.subscribe();
    await store.settled();
    expect(store.isListening()).toBe(true);
    expect(registered.has('diarization-progress')).toBe(true);
  });

  test('a later subscriber retries the bridge while earlier ones still wait', async () => {
    // The recovery does not need an unrelated 0→1 cycle: a subscriber that
    // arrives while the store listens to nothing retries the attach, so the
    // surfaces already waiting (a panel mounted before the bridge was ready)
    // start seeing events as soon as any new surface subscribes.
    let attempts = 0;
    const registered = new Map<string, (event: { payload: unknown }) => void>();
    const listen = async (
      name: string,
      handler: (event: { payload: never }) => void,
    ) => {
      attempts += 1;
      // The first start's very first listen fails; every later listen (from
      // a retry) lands, because a registration aborts at its first failure.
      if (attempts === 1) throw new Error('bridge not ready');
      registered.set(name, handler as never);
      return () => registered.delete(name);
    };
    const store = new DiarizationPassStore(listen as never);
    const early = store.subscribe();
    await store.settled();
    expect(store.isListening()).toBe(false);

    const late = store.subscribe();
    await store.settled();
    expect(store.isListening()).toBe(true);
    expect(registered.has('diarization-progress')).toBe(true);

    registered.get('diarization-progress')?.({
      payload: { meeting_id: 'meeting-a', stage: 'queued' },
    });
    expect(store.getState('meeting-a')?.stage).toBe('queued');
    early();
    late();
    store.dispose();
  });

  test('markPassStarted marks the pass running before its first stage lands', async () => {
    // The manual run's click is the panel's running truth: without this the
    // button would stay clickable until the first `diarization-progress`
    // event, and a second click would queue a second pass.
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    const seen: Array<string | null> = [];
    store.subscribe(() => seen.push(store.getState('meeting-a')?.phase ?? null));
    await store.settled();

    store.markPassStarted('meeting-a');
    expect(store.getState('meeting-a')).toMatchObject({
      meetingId: 'meeting-a',
      phase: 'running',
      stage: null,
      progressPercentage: null,
    });
    expect(seen).toEqual(['running']);

    // A terminal ends it like any other pass: the manual run's completion or
    // the native terminal, not a panel-local flag.
    emit(bridge, 'transcript-updated', { meeting_id: 'meeting-a' });
    expect(store.getState('meeting-a')).toBeNull();
    store.dispose();
  });

  test('a subscribe/unsubscribe race mid-registration leaves no orphan listener', async () => {
    // React StrictMode mounts, unmounts and remounts; an unsubscribe that
    // lands while the bridge is still registering must not leave the
    // registrations attached after the last subscriber has left — they would
    // notify a dead component forever and keep the bridge busy.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const registered = new Map<string, (event: { payload: never }) => void>();
    const unlistened: string[] = [];
    let calls = 0;
    const listen = async (
      name: string,
      handler: (event: { payload: never }) => void,
    ) => {
      calls += 1;
      if (calls === 1) await gate;
      registered.set(name, handler);
      return () => {
        registered.delete(name);
        unlistened.push(name);
      };
    };
    const store = new DiarizationPassStore(listen as never);

    const offFirst = store.subscribe();
    // The unsubscribe lands while the first listen is still in flight.
    offFirst();
    releaseFirst();
    await store.settled();

    expect(registered.size).toBe(0);
    expect(store.isListening()).toBe(false);

    // A later subscriber still gets a working bridge.
    const offSecond = store.subscribe();
    await store.settled();
    expect(store.isListening()).toBe(true);
    offSecond();
    expect(registered.size).toBe(0);
  });

  test('the stage list mirrors the native snake_case stages', () => {
    // Order is the pass order; the reducer and the panel map every member.
    expect([...DIARIZATION_STAGES]).toEqual([
      'queued',
      'loading_model',
      'decoding',
      'inferring',
      'applying_labels',
    ]);
  });

  test('a terminal is recorded even when the watcher subscribed too late', async () => {
    // The import dialog learns its meeting id only when the transcript is
    // saved; if the fast pass's terminal already fired, the store must still
    // be able to answer "this meeting's pass is over", or the bar would hang
    // waiting for a completion that already happened.
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    expect(store.hasSeenTerminal('meeting-a')).toBe(false);
    emit(bridge, 'transcript-updated', { meeting_id: 'meeting-a' });
    expect(store.hasSeenTerminal('meeting-a')).toBe(true);

    // A fresh subscriber sees the finished record too.
    const late = new DiarizationPassStore(bridge.listen as never);
    late.subscribe();
    await late.settled();
    emit(bridge, 'speaker-names-reset', { meeting_id: 'meeting-b' });
    expect(late.hasSeenTerminal('meeting-b')).toBe(true);
    store.dispose();
    late.dispose();
  });

  test('a new pass supersedes the terminal recorded for an earlier one', async () => {
    // A meeting can be diarized again (manual re-run, retranscription): the
    // fresh pass is not finished just because an earlier pass ended.
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'transcript-updated', { meeting_id: 'meeting-a' });
    expect(store.hasSeenTerminal('meeting-a')).toBe(true);

    emit(bridge, 'diarization-progress', progress({ stage: 'queued' }));
    expect(store.hasSeenTerminal('meeting-a')).toBe(false);
    expect(store.getState('meeting-a')?.stage).toBe('queued');
    store.dispose();
  });

  test('clear forgets the finished record so a rescheduled pass is not pre-ended', async () => {
    const bridge = harness();
    const store = new DiarizationPassStore(bridge.listen as never);
    store.subscribe();
    await store.settled();

    emit(bridge, 'diarization-unavailable', { meeting_id: 'meeting-a', status: 'failed' });
    expect(store.hasSeenTerminal('meeting-a')).toBe(true);

    store.clear('meeting-a');
    expect(store.hasSeenTerminal('meeting-a')).toBe(false);
    store.dispose();
  });
});
