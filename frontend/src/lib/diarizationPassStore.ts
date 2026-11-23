/**
 * The production diarization pass store: one shared instance of the seam's
 * pass state, backed by the single `diarization-progress` listener.
 *
 * Lives in its own file (like `diarizationClient.ts`) so the pure seam in
 * `diarization.ts` stays importable by unit tests without a Tauri bridge,
 * while components get the real store by default and tests inject a fake.
 */

import { DiarizationPassStore } from './diarization';

export const diarizationPassStore: DiarizationPassStore = new DiarizationPassStore();
