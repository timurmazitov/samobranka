import { useEffect, useState } from 'react';

/**
 * What the hook needs from the Tauri event bridge. Injectable for the same
 * reason `useSpeakerNamesResetListener` injects `listenImpl`: a unit test can
 * drive the gate with fake events without a module-level Tauri mock.
 */
export type RetranscriptionListen = (
  event: string,
  handler: (event: { payload: { meeting_id?: string } }) => void,
) => Promise<() => void>;

export type RetranscriptionInvoke = <T>(command: string) => Promise<T>;

/** Production bridges: Tauri's `listen`/`invoke`, imported lazily so merely
 * importing this module never touches the native dependency. */
const tauriListen: RetranscriptionListen = async (event, handler) => {
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ meeting_id?: string }>(event, handler);
};

const tauriInvoke: RetranscriptionInvoke = async <T,>(command: string) => {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command);
};

/**
 * Whether a retranscription is running for one meeting.
 *
 * The truth lives in native code (`is_retranscription_in_progress_command`,
 * a single global flag — only one retranscription runs app-wide at a time);
 * the open page follows it through the same `retranscription-progress` /
 * `-complete` / `-error` events the RetranscribeDialog listens to. The gate
 * closes transcript deletion (ticket 01) while the transcript is being
 * rewritten from the audio; the diarization phase that follows is covered by
 * the shared pass store's `isDiarizing` gate.
 *
 * The seed read matters: a run started before this page mounted (or
 * surviving a navigation) must close the gate from the first render, not
 * only from the next progress event. A failed seed read leaves the gate
 * open — an honest failure of the probe must not freeze the page (the same
 * rule as a `failed` diarization phase).
 */
export function useRetranscriptionRunning(
  meetingId: string | null | undefined,
  listenImpl: RetranscriptionListen = tauriListen,
  invokeImpl: RetranscriptionInvoke = tauriInvoke,
): boolean {
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!meetingId) {
      setRunning(false);
      return;
    }

    let cleanedUp = false;
    const unlisteners: (() => void)[] = [];

    const track = (event: string, running: boolean, scopedToMeeting: boolean) =>
      listenImpl(event, (payload) => {
        // Opening is meeting-scoped: only a run of THIS meeting opens its
        // gate. Closing is global: only one retranscription runs app-wide at
        // a time (native `RETRANSCRIPTION_IN_PROGRESS`), so any terminal
        // event — whatever meeting it names — means the single run ended and
        // every meeting's gate must clear. Without this, navigating to another
        // meeting during a run could leave that meeting's gate stuck open.
        if (running && scopedToMeeting
          && payload.payload.meeting_id
          && payload.payload.meeting_id !== meetingId) return;
        setRunning(running);
      }).then((stop) => {
        if (cleanedUp) {
          stop();
          return;
        }
        unlisteners.push(stop);
      });

    const setup = async () => {
      // Seed first: the dialog may be closed and the page remounted while
      // the native run is still going. The flag is global, so it may briefly
      // gate a different meeting than the one being retranscribed — a safe
      // over-block the first terminal event clears.
      try {
        const inProgress = await invokeImpl<boolean>('is_retranscription_in_progress_command');
        if (cleanedUp) return;
        setRunning(inProgress);
      } catch (error) {
        console.warn('Failed to probe retranscription state:', error);
      }
      await Promise.all([
        track('retranscription-progress', true, true),
        track('retranscription-complete', false, false),
        track('retranscription-error', false, false),
      ]);
    };

    void setup().catch((error) => {
      // The gate is a hint from a background process: without a Tauri bridge
      // (unit tests, a plain browser preview) the page must keep working.
      console.warn('Failed to listen for retranscription progress:', error);
    });

    return () => {
      cleanedUp = true;
      unlisteners.forEach(stop => stop());
    };
  }, [meetingId, listenImpl, invokeImpl]);

  return running;
}
