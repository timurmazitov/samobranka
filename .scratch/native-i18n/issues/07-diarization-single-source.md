# Collapse duplicated diarization messages to one source

Status: ready-for-human
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

## Acceptance status

- [x] One source of truth: the five English sentences exist only in
  `frontend/src/i18n/locales/en/translation.json` (`speakers.failures.*`),
  grep output in the close-out below.
- [ ] Russian toasts in all four render paths verified in the running app:
  the code→catalog resolution is unit-tested in both locales
  (`live-diarization.test.ts` resolves every code in en+ru; the four render
  paths are unit-tested to show catalog text), but `tauri:dev` was not
  started per the implementation directive — a GUI walk-through in Russian
  is still owed (consolidated GUI pass).
- [x] `live-diarization.test.ts` (20 pass), `i18n-parity` (5), `i18n-usage`
  (11), `cargo test -p samobranka --lib` (765 pass / 0 fail / 7 ignored —
  identical to the base) all green.
- [x] `showDiarizationFailure` never renders an empty description: code →
  prose (D7 fallback, only if non-blank) → `speakers.failures.failed`;
  three tests pin the chain.

## Comments

- 2026-11-23 (feat/ni-07, impl): **Rust now emits state codes, prose fields
  dropped.** `diarization_service.rs` replaces the five prose constants with
  `DIARIZATION_UNAVAILABLE_CODE`/`DIARIZATION_RUNTIME_UNAVAILABLE_CODE`/
  `DIARIZATION_FAILED_CODE`/`DIARIZATION_DEFERRED_CODE`/
  `SPEAKER_NAMES_RESET_CODE` (literals `unavailable`|`runtime_unavailable`|
  `failed`|`deferred`|`reset`). `diarization_run::unavailable_message` became
  `unavailable_code`; the `diarization-unavailable` payload gained `"code"`
  and the `message` field was **dropped at the emit** (see the keep/drop
  decision below); all three `speaker-names-reset` emitters
  (`diarization_run.rs`, `import.rs`, `retranscription.rs`) now send
  `"code": "reset"` instead of the prose. Ticket 05's
  `TRANSCRIPTION_RUNTIME_USER_MESSAGE` untouched (concurrent ticket).
- 2026-11-23 (feat/ni-07, impl): **constants keep/drop decision.** Grep over
  every consumer before dropping: the five Rust prose constants reached the
  UI only as the `message` field of the two terminal events, rendered by
  exactly four paths — `useImportAudio.ts:302` + `RetranscribeDialog.tsx:345`
  (→ `showDiarizationFailure`), `useSpeakerNamesResetListener.ts:63`, and the
  live-stop flow (no message at all; it rendered the TS mirror). The
  pass-state reducer (`applyDiarizationFailure`) reads `payload.message` only
  as a diagnostic `error` when `reason` is absent. Once all four paths
  resolved `speakers.failures.<code>` through `t()`, **no consumer rendered
  the prose**, so the Rust prose constants were deleted and the emit dropped
  `message` (the spec's "keep prose during migration" ends here: the
  migration is this ticket). The TS *interfaces* keep the optional `message`
  field on both payloads because a new frontend can receive an old Rust
  build's payload (`showDiarizationFailure`/the reset listener still fall
  back to prose for an unknown `code` per D7, and the reducer keeps its
  reason→message→null diagnostic chain); `WireDiarizationFailureCode`
  widens to `string` so a future code cannot break rendering.
- 2026-11-23 (feat/ni-07, impl): **stage-map finding (work item 4).** The raw
  `DiarizationPhase::message()` text is **unreachable as a render fallback**:
  `diarizationStageMessage()` switches over the five-variant union with no
  default, the `DiarizationStage` pin test keeps native and TS in lockstep,
  unknown stages are dropped by `applyDiarizationProgress` before any render,
  and no component reads the stored `DiarizationPassState.message` (grep:
  the only readers of `progress?.message` in the two dialogs are the
  `import-progress`/`retranscription-progress` payloads — ticket 06's
  channel, untouched). The new stage-key test additionally proves every
  stage resolves to a non-empty sentence in both locales, so the literal
  `t()` keys can never render as raw key paths. The Rust sentences stay as
  log self-description; the module comment at `diarization_service.rs`
  (was `:151-154`) was corrected — it falsely claimed "bars that print the
  raw payload message" existed on this channel.
- 2026-11-23 (feat/ni-07, impl): frontend: TS mirrors in `lib/diarization.ts`
  deleted; `diarizationFailureMessage(code)` + `showDiarizationFailure(toast,
  {code,message})` + `diarizationStatusMessage` now resolve
  `speakers.failures.*` literally (usage-guard visible); new keys
  `speakers.failures.{unavailable,runtime_unavailable,failed,deferred,reset,
  noSpeakersFound}` and `speakers.hints.noModel` in en+ru (ru impersonal,
  «Спикер»/«диаризация» per GLOSSARY; model name Latin). `SpeakersPanel`
  hints/tooltips and the no-speakers explanation move to `t()` too (they
  were the same duplicated prose — the old "the hint is a substring of the
  native sentence" pin died with the constants; `hints.noModel` keeps the
  panel's short wording deliberately). `live-diarization.test.ts`: the
  "mirror the native message strings verbatim" block became "every state
  code resolves to a non-empty translation in both locales" + a
  readFileSync pin of the code literals and emit sites in the Rust source
  (same technique as the surviving event-name/band/stage-enum pins, which
  stay); `diarization-pass-state.test.ts` and
  `speakers-panel-pass-indicator.test.tsx` now use content-neutral wire
  prose so the acceptance grep is not polluted by test fixtures.
- 2026-11-23 (feat/ni-07, impl): acceptance grep, from `frontend/` (the five
  sentences + the no-speakers sentence; each appears exactly once, in the
  English catalog; the one test hit is the anti-assertion that pins the
  native source free of them):

      $ grep -rn "Speaker labels were skipped\|Speaker labels were postponed\|Speaker names were reset because" src src-tauri/src tests
      src/i18n/locales/en/translation.json:965:      "unavailable": "Speaker labels were skipped. Download the Nemotron-3-Diarization model in Settings to see who said what.",
      src/i18n/locales/en/translation.json:966:      "runtime_unavailable": "Speaker labels were skipped. The audio.cpp engine is unavailable on this system.",
      src/i18n/locales/en/translation.json:967:      "failed": "Speaker labels were skipped because diarization failed.",
      src/i18n/locales/en/translation.json:968:      "deferred": "Speaker labels were postponed because a recording is in progress. Run diarization again once the recording stops.",
      src/i18n/locales/en/translation.json:969:      "reset": "Speaker names were reset because the voices were recomputed.",
      tests/lib/live-diarization.test.ts:342:    expect(source).not.toMatch(/Speaker names were reset because/);

      $ grep -rn "found no distinct speakers in this recording" src src-tauri/src tests
      src/i18n/locales/en/translation.json:970:      "noSpeakersFound": "Diarization finished but found no distinct speakers in this recording."

  (The Russian catalog carries the translations, which the phrases above
  cannot match — `i18n-parity` pins key equality.)
- 2026-11-23 (feat/ni-07, impl): ran (Linux x86_64, bun, from `frontend/`):
  per-file `bun test` green — live-diarization 20, i18n-parity 5,
  i18n-usage 11, diarization-pass-state 32, diarization-availability 14,
  import-diarization-toast 5, speaker-names-reset-listener 7,
  live-recording-diarization 4, live-stop-speaker-stage 6,
  speakers-panel-pass-indicator 15, speakers-panel 36,
  retranscribe-diarization-toast 3, retranscribe-diarization-bar 6,
  import-audio-diarization 6, swept-components-i18n 7. Full `bun test`:
  564 pass / 9 fail — the same 9 known cross-file `mock.module` baseline
  failures (`meeting-rename-export` ×6, `app-window-title` ×2, 1 unnamed),
  none in files this ticket touched. `tsc --noEmit`: only the pre-existing
  `stage-transcribe-native.test.ts` TS7053 baseline error.
  `cargo test -p samobranka --lib` (`CARGO_TARGET_DIR=/home/timur/cargo-targets/ni-07`
  — `/tmp` tmpfs was full from concurrent agents' caches, deviation):
  765 pass / 0 fail / 7 ignored, twice; one intermediate run showed a single
  unrelated flake (`audio_cpp_engine::wrapper::…::variant_subdirectory_wins…`,
  a tmpdir-discovery test that passed in isolation ×3 and in the two full
  reruns). `cargo clippy -p samobranka --lib`: no new warnings in the
  touched files (the `diarization_progress_event` unused-import warning at
  `diarization_run.rs:23` and the enum size warning were verified
  pre-existing by stashing this ticket's diff).
- 2026-11-23 (feat/ni-07, impl): **not exercised in `tauri:dev`** (parent
  directive). Untested in the running app: the four Russian toast paths and
  the panel hints, and receiving a `speaker-names-reset`/
  `diarization-unavailable` event from a real native pass.
