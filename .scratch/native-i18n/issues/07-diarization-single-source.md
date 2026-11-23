# Collapse duplicated diarization messages to one source

Status: ready-for-agent
Type: task
Blocked by: 02

## Context

`spec.md` D8. Five Rust constants are mirrored verbatim in the frontend and
pinned by a test that asserts the two copies match:

- `frontend/src-tauri/src/audio/transcription/diarization_service.rs:30`
  `DIARIZATION_UNAVAILABLE_MESSAGE`
  (`"Speaker labels were skipped. Download the Nemotron-3-Diarization model in
  Settings to see who said what."`)
- `:35` `DIARIZATION_RUNTIME_UNAVAILABLE_MESSAGE`
- `:39` `DIARIZATION_FAILED_MESSAGE`
- `:46` `DIARIZATION_DEFERRED_MESSAGE`
- `:56` `SPEAKER_NAMES_RESET_MESSAGE`

Mirror: `frontend/src/lib/diarization.ts:88-121`, pinned by
`frontend/tests/lib/live-diarization.test.ts`. Rendered verbatim as toast
descriptions: `hooks/useImportAudio.ts:302` → `showDiarizationFailure`,
`hooks/useSpeakerNamesResetListener.ts:63`, `RetranscribeDialog.tsx:345`,
and the live-stop flow.

This is exactly the duplicated source of truth the governing rule exists to
prevent — and it is already in the codebase.

## Work

1. Rust emits a **state code** instead of prose:
   `unavailable` | `runtime_unavailable` | `failed` | `deferred` | `reset`.
   Additive per spec D7: keep the prose field as fallback during migration, then
   it can be dropped once no consumer reads it.
2. The TS mirrors in `lib/diarization.ts:88-121` become `t()` calls against keys
   like `speakers.failures.<code>`; the Rust constants are deleted once the
   frontend is the only producer.
3. Repoint `tests/lib/live-diarization.test.ts` from "the two texts match" to
   "every code resolves to a non-empty translation in both locales".
4. The stage→message map at `diarization_service.rs:155-165`
   (`"Loading the diarization model..."`, `"Detecting speakers..."`, …) is a
   separate but adjacent case: the module comment at `:151-154` already says the
   frontend keeps its own i18n strings keyed by stage and may override this text,
   and `lib/diarization.ts:285` `diarizationStageMessage()` uses
   `i18n.t('speakers.stages.*')`. **Verify the raw `message` is no longer
   reachable as a fallback for unseen stages** — if it is, give the fallback a
   code too rather than shipping English.

## Acceptance

- One source of truth: `grep` for the English sentences finds them only in the
  i18n catalogs.
- Toast descriptions appear in Russian for all five states, in all four render
  paths (import, retranscribe, live stop, speakers panel).
- `live-diarization.test.ts`, `i18n-parity`, `i18n-usage`, `cargo test` pass.
- `showDiarizationFailure` never renders an empty description.
