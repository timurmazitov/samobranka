# Add error codes to the transcription-error chain

Status: ready-for-human
Type: task
Blocked by: 02

## Context

`spec.md` governing rule and D7 — the third reported surface. The visible English
in the "transcription progress" area is mostly this chain: Rust emits
`userMessage` prose and React renders it verbatim.

Rendered paths:

- `frontend/src/hooks/useModalState.ts:134-147` — `actionable` →
  `showModal('modelSelector', userMessage)`, else
  `toast.error('', { description: userMessage })`.
- `frontend/src/components/RecordingControls.tsx:278` → `onTranscriptionError` →
  `showModal('errorAlert', message)` → `app/_components/SettingsModal.tsx:314`.

Rust-authored strings in the chain:

- `frontend/src-tauri/src/audio/transcription/worker.rs:194`
  `"Recording failed: Unable to initialize speech recognition. Please check your
  model settings."`, `:435` `format!("Transcription failed: {}", error)`.
- `frontend/src-tauri/src/audio/recording_commands.rs:500, 755`
  `format!("Recording cannot start: {}", validation_error)`.
- `frontend/src-tauri/src/audio/transcription/provider.rs:27, 33, 34-35`
  (`"No transcription model is loaded"`, `"Transcription engine failed: {msg}"`,
  `"Language '{}' is not supported by this provider"`).
- `frontend/src-tauri/src/transcribe_cpp_engine/transcription.rs:245, 249, 255,
  260, 265, 270` — the model-not-ready family, e.g.
  `"Transcribe.cpp model '{}' is still downloading ({}%). Please wait for it to
  finish."`
- `frontend/src-tauri/src/audio/transcription/engine.rs:316, 323`.

## Work

1. **Additive only** (spec D7): add `code` (+ `params` where a value is
   interpolated) to these payloads and **keep** the existing English field as the
   diagnostic fallback. Do not delete prose — it is what appears in logs and in
   user screenshots.
2. Codes are stable identifiers (`transcription.model_not_downloaded`,
   `transcription.model_corrupted`, `transcription.language_unsupported`, …), not
   the English text. Note `transcribe_cpp_engine/transcription.rs:245-270` are
   already one enum-like family — one code per variant, model name and percent in
   `params`.
3. Frontend resolves `t('transcription.errors.<code>', params)`; on an unknown
   code it falls back to the existing prose field, never to an empty string
   (spec D7).
4. Native-library detail stays raw in `params.detail` and is shown as-is (spec
   D7) — e.g. the tail of `"Transcribe.cpp model '{}' has an error: {}."`.
5. Keep `phase`/`actionable` semantics untouched: `RecordingControls.tsx:278`
   keys behaviour off `phase`, and `useModalState` branches on `actionable`.
   A regression there changes which UI shows the message, not just its language.
6. `TRANSCRIPTION_RUNTIME_USER_MESSAGE` (`recording_commands.rs:144`) is mirrored
   verbatim as a frontend const used at `hooks/useRecordingStart.ts:365` —
   coordinate it here the same way ticket 07 does for diarization, or note it for
   ticket 07 if it is cleaner to unify there.

## Acceptance

- [x] Unknown/absent `code` still renders the English fallback — tested
  (`tests/lib/transcription-error.test.ts`,
  `tests/components/use-modal-state-transcription-error.test.tsx`).
- [x] Interpolated values render correctly in Russian (percent, model name) —
  tested in ru.
- [x] Existing listeners unmodified in behaviour (`actionable`/`phase`
  branching pinned by the wiring test); `i18n-parity`/`i18n-usage` pass;
  `cargo test -p samobranka --lib` passes.
- [x] With UI language Russian, each message resolves to its catalog key
  (unit level): no model installed, model not downloaded, model still
  downloading (percent shown), model corrupted, model errored, engine not
  initialized, language unsupported, transcription init failure, recording
  cannot start.
- [ ] Verified in `tauri:dev` by stopping the flow that triggers each message
  (per-message GUI reproduction deferred to the consolidated `tauri:dev` pass).

## Comments

- 2026-11-23 (feat/ni-05, impl): **Code registry**: `frontend/src-tauri/src/error_codes.rs`
  — one module with all `pub const TRANSCRIPTION_*` codes, the doc-comment
  registry table (code → emitter → params), `CodedError { message, code, params }`
  with `From<ModelNotReady>` / `From<TranscriptionError>`, and the shared
  `transcription_error_payload(...)` builder that keeps every `transcription-error`
  emission one shape (camelCase `userMessage`, snake `code`/`params`; `code`/
  `params` serialize as `null` when absent — the resolver treats null as no
  code). Catalog keys `transcription.errors.*` in `en`+`ru` (15 keys; ru
  impersonal, «модель транскрибации», Latin technical tokens per spec
  Vocabulary). Frontend resolver `src/lib/transcription-error.ts`
  (`transcriptionErrorText`: code → `t('transcription.errors.<suffix>', params)`
  with `defaultValue: ''`, falling back to `userMessage`, then to `error` —
  never blank); wired into the `useModalState` listener for both the
  model-selector branch and the toast. `TranscriptionErrorPayload` gained
  optional `code`/`params`. Pinning test
  `tests/lib/transcription-error-i18n.test.ts` extracts the registry consts
  and requires a non-empty key in both locales in both directions (ticket-06
  technique).
- 2026-11-23 (feat/ni-05, impl): Emitters coded: worker.rs engine-init
  failure (prefers the concrete failing stage's code — a downloading model
  reaches init too — and falls back to `transcription.engine_init_failed` for
  codeless internal bugs), worker.rs per-chunk provider error (code from the
  `TranscriptionError` variant), both recording_commands.rs model-validation
  emits, and the `TRANSCRIPTION_RUNTIME_*` emit
  (`transcription.runtime_unavailable`). To carry codes without re-parsing
  prose, the transcription-init chain (`validate_transcription_model_ready`,
  `get_or_init_transcription_engine`, the three `get_or_init_transcribe_cpp_provider*`
  functions) now returns `CodedError` instead of `String`; `Display`/`message`
  keep the exact old prose (import/retranscription `anyhow!` conversions and
  `Err(validation_error.message)` are byte-identical to before).
  `engine.rs:316/323` manager-missing and discovery-failure carry
  `model_manager_uninitialized` / `model_discovery_failed`; the native load
  failure carries the new `model_load_failed` with the raw native message in
  `params.detail` (spec D7). `audio_too_short` is coded for family
  completeness although worker.rs only counts it in stats and never emits it.
- 2026-11-23 (feat/ni-05, impl): **TRANSCRIPTION_RUNTIME_USER_MESSAGE
  decision** (work item 6): the frontend const mirror was already deleted by
  ticket 09; grep confirms no live frontend consumer of the prose or the
  `TRANSCRIPTION_RUNTIME_START_ERROR_CODE` string beyond the still-used
  `isTranscriptionRuntimeStartError` in `hooks/useRecordingStart.ts` (that one
  matches the command's `Err` string, not the prose, and stays). The Rust
  constants are **not dead**: `TRANSCRIPTION_RUNTIME_USER_MESSAGE` still
  feeds the payload's `userMessage` (logs/screenshots/fallback — additive
  rule), so both stay untouched; the payload additionally carries
  `code: transcription.runtime_unavailable` with the catalog wording.
- 2026-11-23 (feat/ni-05, impl): **errorAlert path left as-is**: its only
  producer is `RecordingControls.tsx`'s *legacy* `transcript-error` listener
  (bare-string payload, no code field) — Rust has no `transcript-error`
  emitter at all (grep over `src-tauri`), and the structured
  `transcription-error` listener in `RecordingControls` never calls
  `onTranscriptionError` (behaviour: count + phase-keyed stop only). So no
  code-bearing payload can reach `showModal('errorAlert', …)` /
  `SettingsModal.tsx`; the prose render there is already the correct fallback.
- 2026-11-23 (feat/ni-05, impl): ran (Linux x86_64, bun, from `frontend/`):
  per-file `bun test` green — transcription-error 10, transcription-error-i18n 3,
  use-modal-state-transcription-error 3 (driven red first: the two coded cases
  failed before the resolver was wired), i18n-parity 5, i18n-usage 11,
  recording-controls-stop 8, transcription-client-defaults 5,
  live-recording-diarization 4, live-stop-speaker-stage 6,
  meeting-rename-export 6, native-progress 12, native-progress-i18n 5,
  native-progress-render 9, live-diarization 20. `tsc --noEmit`: only the
  pre-existing `stage-transcribe-native.test.ts` TS7053 baseline error
  (identical on the main tree). `cargo test -p samobranka --lib`
  (`CARGO_TARGET_DIR=/home/timur/sources/tmp/cargo-target-ni-05`): 774 pass /
  0 fail / 7 ignored, incl. 7 new `error_codes` tests. `cargo clippy -p
  samobranka --lib`: 138 warnings = verified baseline by stashing the diff;
  none in the touched files (`--all-targets`: 170 = baseline too).
- 2026-11-23 (feat/ni-05, impl): **not exercised in `tauri:dev`** (parent
  directive). Untested in the running app: the nine Russian error surfaces
  end-to-end (each must be triggered by stopping the flow that produces it —
  consolidated GUI pass).
