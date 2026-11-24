'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { DiarizationPassStore } from '@/lib/diarization';
import { diarizationPassStore as defaultPassStore } from '@/lib/diarizationPassStore';

/**
 * Whether a diarization pass is running for one meeting, read from the shared
 * pass store — the same source of truth the speakers panel gates its buttons
 * on, so transcript text editing and the panel block and unblock together.
 *
 * The store keeps every meeting's state; a `failed` phase is not running (an
 * honest death of a pass must not freeze the page), and an unknown meeting is
 * simply not running. The seam store is injectable so tests drive it with
 * fake progress events, mirroring SpeakersPanel's `passStore` prop.
 */
export function useDiarizationPassRunning(
  meetingId: string | undefined,
  passStore: DiarizationPassStore = defaultPassStore,
): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => passStore.subscribe(onChange),
    [passStore],
  );
  const read = useCallback(
    () => (meetingId ? passStore.getState(meetingId) : null),
    [passStore, meetingId],
  );
  // The snapshot must stay referentially stable between notifications; the
  // store hands out the same state object until an event replaces it.
  const passState = useSyncExternalStore(subscribe, read, () => null);

  return passState !== null && passState.phase === 'running';
}
