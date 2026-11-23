# Localize model descriptions in the model-picker window

Status: resolved
Type: task

## Context

`spec.md` D6 — one of the three reported surfaces. The transcription
model-picker cards render Rust-authored English prose:

- `frontend/src/components/TranscribeCppModelManager.tsx:462` `{model.display_name}`,
  `:468` `{model.description}`, `:469` `{model.family}`;
  `display_name` / `description` are `&'static str` in the static catalog at
  `frontend/src-tauri/src/transcribe_cpp_engine/catalog.rs:178-269`
  (e.g. `:184` `"Russian speech recognition (GigaAM v3 CTC). Strong accuracy for
  Russian meetings."`).
- Same shape for diarization: `AudioCppModelManager.tsx:459` and
  `frontend/src-tauri/src/audio_cpp_engine/catalog.rs:146-147`.
- Nothing is remote: `source_url` (`catalog.rs:156-166`, `:148-151`) is a pinned
  HuggingFace URL that is not shipped in `ModelInfo` and never fetched for
  display metadata.

Card chrome (`Ready`, `Selected`, `Download`, `Retry`, …) and sizes
(`formatModelSize`) are **already** localized. Do not touch them.

## Work

1. Move `description` into the frontend catalog, resolved by `family`:
   `models.transcribeCpp.descriptions.<family>` and
   `models.audioCpp.descriptions.<family>`, in both
   `frontend/src/i18n/locales/{en,ru}/translation.json`.
   Precedent to follow: the card already ignores the Rust `ModelTask::label()`
   (`audio_cpp_engine/catalog.rs:43-46`) and uses `taskLabel()` from
   `frontend/src/lib/audiocpp.ts:105` → `i18n.t('models.audioCpp.taskDiarization')`.
2. Do **not** translate `display_name` (`GigaAM v3 CTC`, `Whisper large-v3
   Turbo`, `Parakeet Ultra`, `Nemotron-3 Diarization`), `family`, or
   `quantization` (`Q8_0`, `BF16`) — proper names and technical tokens, per the
   Latin-script rule in `.scratch/i18n/spec.md`.
3. Remove the compile-time English sentence appended by the macro at
   `transcribe_cpp_engine/catalog.rs:154`
   (`concat!($description, " Quantization: ", stringify!($quant), ".")`) and
   render the quantization note from a frontend key next to the badge that
   already shows `quantization`.
4. Rust keeps `description` as a fallback for non-rendered consumers (logs) or
   drops the field if no consumer remains — decide by checking callers of
   `ModelInfo::description` before deleting; do not break the serde shape
   silently, since `frontend/src/lib/transcribeCpp.ts:24-37` and
   `lib/audiocpp.ts` mirror these structs by hand (no ts-rs/specta in this repo).
5. Update the catalog tests at `transcribe_cpp_engine/catalog.rs:281-580` if
   they assert the appended quantization suffix.
6. Wording: descriptions are the one place where a *recommendation* reads better
   in Russian than a gloss. Keep `Vulkan`, `CPU`, `GGUF`, model/engine names in
   Latin. Use glossary terms (Транскрибация / Транскрипция / Спикер).

## Acceptance

- A test asserts every `family` present in both Rust catalogs has description
  keys in **both** locales — this is the guard against a newly added model
  arriving with an empty description (spec D6 consequence).
- `i18n-parity` and `i18n-usage` tests pass.
- In `tauri:dev`, Settings → Транскрибация: both model managers show Russian
  descriptions when the UI language is Russian, English otherwise, and switching
  language re-renders the cards without restart.
- Verified that the quantization note still appears (moved, not lost).
