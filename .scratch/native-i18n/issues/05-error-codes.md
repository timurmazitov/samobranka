# Add error codes to the transcription-error chain

Status: ready-for-agent
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

- With UI language Russian, each of these produces a Russian message: no model
  installed, model not downloaded, model still downloading (percent shown),
  model corrupted, model errored, engine not initialized, language unsupported,
  transcription init failure, recording cannot start.
- Unknown/absent `code` still renders the English fallback — test it.
- Interpolated values render correctly in Russian (percent, model name).
- Existing listeners unmodified in behaviour; `i18n-parity`/`i18n-usage` pass;
  `cargo test` passes.
- Verified in `tauri:dev` by stopping the flow that triggers each message, not
  only by unit test.
