# Delete progress strings no listener reads

Status: needs-info
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

- App still starts, records, stops, transcribes; shutdown progress overlay still
  works (it comes from `app/_components/StatusOverlays.tsx`, which is already
  localized).
- No unused English strings remain in the deleted set; `cargo build` free of dead
  code warnings for them.
- The Vulkan decision is recorded in this file under `## Comments`.
