# Delete progress strings no listener reads

Status: ready-for-agent
Type: task

## Context

`spec.md` D9. Rust emits `message` fields on events that have **no frontend
listener**, or whose listener reads only a stage/flag. Translating them would
create catalog keys nobody maintains, and deleting them first keeps the later
translation honest. Deleting is its own ticket so a regression is attributable.

Verified by grepping for listeners (`listen(...)` / event-name strings):

| Event | Rust site | Status |
| --- | --- | --- |
| `recording-shutdown-progress` | `audio/recording_commands.rs:1000, 1048, 1076, 1116, 1190, 1255, 1264` | listener reads only `payload.stage` (`contexts/RecordingStateContext.tsx:167-174`) |
| `transcription-progress` | `audio/transcription/worker.rs:333` | no listener |
| `transcription-queue-complete` | `worker.rs:359` | no listener |
| `transcript-chunk-loss-detected` | `worker.rs:389` | no listener |
| `transcription-warning` | `audio/transcription/engine.rs:377`, `transcribe_cpp_engine/transcription.rs:224` (Vulkan fallback notice) | no listener |
| `speech-detected` | `worker.rs:260` | listeners flip a boolean only (`RecordingControls.tsx:302`, `TranscriptPanel`/`TranscriptView.tsx:148`) |

Also `recording-started` (`recording_commands.rs:691-693`), `recording-stopped`
(`:1264`), `recording-paused` (`:1311`), `recording-resumed` (`:1345`),
`recording-starting` (`:514, 769`) carry message strings consumed for state only
(`services/recordingService.ts:139`).

## Work

1. Re-verify each row before deleting (the reports are from one sweep; a listener
   added since would change the answer). Confirm via `grep` for the event name
   string under `frontend/src`.
2. Drop the `message` field from the payloads (or the struct field entirely where
   nothing else uses it) and remove the now-unused English literals.
3. **Do not delete** the `stage`/`phase` tokens — the frontend keys off them.
4. `transcription-warning` / the Vulkan-fallback notice
   (`transcribe_cpp_engine/transcription.rs:224`, "Transcribe.cpp could not start
   on Vulkan … See Settings → Transcription models → Compute mode.") is
   genuinely useful to users and currently unreachable. Decide: surface it later
   (then it gets a code like ticket 05) or keep as log-only. **This is the open
   question — answer before implementing that row.**
5. Also re-triage `import-warning` (`audio/import.rs:501-509`) here: no frontend
   listener was found, so it may be dead code rather than an unlocalized surface
   (listed in spec "Out of scope").

## Acceptance

- [ ] App still starts, records, stops, transcribes; shutdown progress overlay still
  works (it comes from `app/_components/StatusOverlays.tsx`, which is already
  localized). *(Untested here — consolidated `tauri:dev` run deferred; see ##
  Comments.)*
- [x] No unused English strings remain in the deleted set; `cargo build` free of dead
  code warnings for them.
- [x] The Vulkan decision is recorded in this file under `## Comments`.

## Comments

- 2026-11-23 (owner decision): `transcription-warning` / Vulkan-fallback notice —
  **keep log-only, surface later**. Do not delete the emit and do not add a
  frontend listener in this ticket. When it is surfaced it gets a `code` like
  ticket 05. The emit stays as-is (or moves to log-only if the event emit itself
  is dead weight); the dead-`message` rows above still get deleted.
- 2026-11-23 (implementer, branch `feat/ni-08`): Re-verified every row by grepping
  the event-name string under `frontend/src` — all rows still hold (zero frontend
  listeners for the dead set; line cites had drifted: `transcription-progress`
  emit is `worker.rs:328`, and `transcription-warning` has THREE emit sites, not
  two). Per-row decisions:
  - `recording-shutdown-progress` (7 emits, `recording_commands.rs`): **deleted
    `message` only**; kept `stage`/`progress`/`detailed`/`elapsed_seconds`
    (`RecordingStateContext.tsx:167` keys off `payload.stage`). The
    shutdown-progress overlay (`StatusOverlays.tsx`) is frontend-localized and
    unaffected.
  - `transcription-progress` (worker.rs:328), `transcription-queue-complete`
    (:357), `transcript-chunk-loss-detected` (:383): **deleted `message` only**;
    kept the structural count fields. Ticket scope is deleting the dead English
    prose, not removing the emits.
  - `speech-detected` (worker.rs:258): **deleted `message`**, payload is now `{}`;
    kept the emit (`RecordingControls.tsx:302` and `TranscriptView.tsx` flip a
    boolean only). Dropped the dead `SpeechDetectedEvent` TS interface in
    `TranscriptView.tsx` (its `message` field was typed but never read).
  - `recording-started` (`recording_commands.rs:691, 936`), `recording-stopped`
    (`:1264`), `recording-paused` (`:1311`), `recording-resumed` (`:1345`),
    `recording-starting` (`:514, 769`): **deleted `message` only**; kept
    `devices`/`workers`/`folder_path`/`meeting_name` — consumers
    (`TranscriptContext.tsx:155`, `useRecordingStop.ts:117`) key off those. Updated
    the `RecordingStoppedPayload` TS type (`services/recordingService.ts`) and the
    `useRecordingStop.ts` inline `listen<>` type, which typed `message` but never
    read it; dropped `message` from the two hook test fixtures.
  - `transcription-warning` — three sites, re-triaged per-site. `engine.rs:377`
    (Vulkan fallback): **kept as-is** per the owner decision above (log-only; the
    emit is not pure dead weight — `vulkan_fallback_warning` still feeds the
    `warn!` line and it is a single-use diagnostic surface to be surfaced later).
    `worker.rs:310` (`EngineFailed`) and `worker.rs:315` (`UnsupportedLanguage`):
    **kept as-is** — same no-listener decision as the Vulkan row (no frontend
    `transcription-warning` listener exists). These carry dynamic
    `error.to_string()` prose, not a fixed `message` field, so the "drop the
    `message` field" instruction does not apply to them; deleting the emit would
    drop a diagnostic that is a sibling of the surface-later Vulkan case. Left for
    ticket 05 to add a `code`.
  - `import-warning` (`import.rs:501-509`): **deleted the emit and the
    `ImportWarning` struct** — no frontend listener, struct used only by that
    emit, and the `warn!("No speech detected in audio")` at `import.rs:497`
    already preserves the diagnostic. Import proceeds; meeting still created with
    no transcripts.
  - **Inverse case — NOT deleted:** `chunk-drop-warning` has a live frontend
    listener (`recordingService.ts:185`, `useModalState.ts:107`) but no Rust emit
    (it is a latent, not dead, surface). Left alone; distinct from the dead
    `transcript-chunk-loss-detected` row.
- 2026-11-23 (implementer close-out): Branch `feat/ni-08` off `feat/native-i18n`
  tip; `feat/native-i18n` merged in before reporting. Ran: `cargo test -p
  samobranka --lib` → 748 pass / 0 fail / 7 ignored; `cargo build` → 13
  pre-existing lib warnings, none in the deleted set (verified each: pipeline/
  recording_preferences/summary/hardware_detector; `import.rs` clean). Frontend:
  `bun test` over the six affected files (`live-recording-diarization`,
  `live-stop-speaker-stage`, `recording-start-transcribe-cpp`,
  `recording-state-shutdown`, `swept-components-i18n`,
  `diarization-speaker-labels`) → 43 pass / 0 fail; `bunx tsc --noEmit` clean for
  these files (only pre-existing `stage-transcribe-native.test.ts` error, present
  on baseline too). **Untested:** manual `tauri:dev` run (start/record/stop/
  transcribe + shutdown overlay) — deferred to the consolidated run; no real
  audio exercised. Sidecars were copied from the main checkout's
  `src-tauri/binaries/` for the build (gitignored artifacts), not rebuilt here.

