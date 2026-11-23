# Localize import and retranscription progress messages

Status: ready-for-human
Type: task
Blocked by: 02

## Context

`spec.md` governing rule, D7, D10. These dialogs render Rust `progress.message`
**verbatim**, so they are a real user-visible English surface:

- `frontend/src/components/ImportAudioDialog/ImportAudioDialog.tsx:288, 327`
  — `progress?.message || …`
- `frontend/src/components/RetranscribeDialog.tsx:489, 520` — `barMessage` /
  description.

Rust sources:

- `frontend/src-tauri/src/audio/import.rs:331, 343, 367, 390, 416, 521, 679,
  712, 733` — static phase labels (`"Creating meeting folder..."`,
  `"Decoding audio file..."`, `"Loading transcription engine..."`,
  `"Import complete"`, …).
- `import.rs:442` `format!("Detecting speech segments... {}% ({} found)")` and
  `:589` `format!("Transcribing segment {} of {} ({:.1}s)...")`.
- `frontend/src-tauri/src/audio/decoder.rs:217, 554`
  (`"Resampling audio: {:.0}%"`, `"Decoding audio: {}%"`).
- `frontend/src-tauri/src/audio/retranscription.rs:179, 203, 220, 316, 475, 551,
  580, 717` plus `:249` and `:385` (same two interpolations).

## Work

1. Add `code` (+ `params`) additively (spec D7) to the `import-progress` and
   `retranscription-progress` payloads; keep `message` as fallback prose.
2. Frontend renders `t('import.progress.<code>', params)` /
   `t('retranscribe.progress.<code>', params)`, falling back to `message`.
   Note both dialogs already key off `stage` for other purposes
   (`RetranscribeDialog.tsx:484` checks `RETRANSCRIPTION_DIARIZING_STAGE`, and
   `retranscribe.stages.*` i18n keys already exist) — **reuse the existing stage
   keys where the phase is the same** instead of minting duplicate keys.
   Also note `RetranscribeDialog.tsx:486` shows raw `progress?.stage ?? ''` as a
   `barStage` fallback: the raw snake_case stage token is user-visible there, so
   decide whether it stays a debug affordance or gets localized.
3. Russian plurals via the ticket-01 helper where the strings live in Rust; in
   the frontend catalogs use the existing `_one/_few/_many/_other` convention
   (`ru/translation.json` already carries 26 such keys). Affected: segments found,
   `segment N of M`, duration `N.Ns`.
4. Duration/number formatting should go through `frontend/src/lib/format-locale.ts`
   so decimals follow the locale (`1,2` vs `1.2`), consistent with `formatModelSize`.

## Acceptance

- [ ] Running an import and a retranscription in Russian shows every phase in
  Russian, with correct plural forms for 1 / 2–4 / 5+ segments and correct
  decimal separators. *(Covered by unit tests — `native-progress.test.ts`
  plural/decimal cases, `native-progress-render.test.tsx` ru renders — but the
  live run is deferred to the consolidated `tauri:dev` pass on a synthetic
  audio file; see ## Comments.)*
- [x] An unknown `code` falls back to the English `message`, never blank.
  *(Unit-tested in both dialogs; `native-progress.test.ts` also pins
  absent-code and inert-params cases.)*
- [x] Cancelling mid-run still shows a sensible message — **covered without
  payload coding**; see the cancel-flow decision in ## Comments.
- [x] `i18n-parity`, `i18n-usage`, `cargo test` pass.
- [ ] Verified in `tauri:dev` on a real synthetic audio file (no private
  recordings in reports). *(Consolidated GUI pass across the native-i18n
  tickets; not run here.)*

## Comments

- 2026-11-23 (implementer, branch `feat/ni-06`): Additive coding per D7 —
  `code` (+ optional `params`) on `ImportProgress` and
  `RetranscriptionProgress`, `#[serde(skip_serializing_if)]` so an un-coded
  payload is byte-identical to the old shape (the pinned
  `batch_event_payloads_share_the_engine_agnostic_shape` test in `common.rs`
  extended with `code: None, params: None`). Codes are `CODE_*` constants in
  `import.rs` / `retranscription.rs` / `decoder.rs`; the frontend pinning test
  `tests/lib/native-progress-i18n.test.ts` extracts them from the Rust sources
  and fails if a catalog key goes missing in either locale or a stage token
  loses its caption word. The English `message` prose is unchanged everywhere.
  - **decoder.rs**: the `ProgressCallback` signature changed from
    `(u32, &str)` to `&DecodeProgress { percent, message, code, params }` so
    the decoder can emit codes itself instead of import pattern-matching the
    prose back. Only `import.rs` supplies callbacks; retranscription uses the
    `None` paths. Resampling percent in `params` uses `{:.0}` rounding to
    match the fallback prose.
  - **Frontend**: `src/lib/native-progress.ts` (the seam, mirroring
    `diarizationStageMessage`); the dialogs resolve
    `t('importAudio.progress.<code>', params)` /
    `t('retranscribe.progress.<code>', params)` in both the bar caption and
    the dialog description, falling back to `message`. `complete` reuses the
    existing `importAudio.stages.complete` / `retranscribe.stages.complete`
    keys (D7 reuse rule, pinned by the resolver test). Plurals:
    `detecting_segments_progress_{one,few,many,other}` selected via `count`
    from `params.found`.
  - **`transcribing_segment` deviation from the ticket's plural ask**: the
    ru wording is the idiomatic «Транскрибация: сегмент N из M» where the
    noun does **not** decline after the following numeral (like «Страница 2 из
    5»). A `_one/_few/_many/_other` family would be four identical strings;
    spec D10 ("cheaper than any plural machinery") — single key, plurals
    kept only where Russian genuinely declines (`...found`). Documented here
    rather than silently.
  - **Duration formatting**: `params.duration_sec` travels as a raw number;
    the resolver renders it through `formatDecimal(..., 1)` → «1,2 с» in ru,
    `1.2s` in en, consistent with `formatModelSize`.
  - **barStage decision (RetranscribeDialog.tsx raw snake_case fallback)**:
    **localized, raw token kept only for unknown stages.** Known native stage
    tokens (`decoding`, `vad`, `transcribing`, `saving`) now resolve through
    `retranscribe.stages.*` (import gains `importAudio.stages.copying/
    resampling/...` likewise); an unseen token still renders verbatim. It is
    a user-visible caption, so per the governing rule it must not be raw —
    but keeping the raw token for unknown stages preserves diagnosability of
    a future native stage from a screenshot, which was the only real value of
    the old behavior. Unit-tested both ways.
  - **Cancel-flow decision (acceptance item 3): covered without coding
    `ImportError`/`RetranscriptionError`.** Both dialogs already render a
    localized cancellation themselves: Cancel press → `t('importAudio.toast.
    cancelled')` / `t('retranscribe.cancelledToast')` toast, and the import
    hook early-returns on `import-error` after a user cancel
    (`isCancelledRef`), while the retranscription dialog closes on cancel.
    So the Rust "Import cancelled" / "Retranscription cancelled" prose never
    reaches the screen as the primary message. The error payloads' own coding
    (which would also cover `"No speech detected in audio file"` — still
    English verbatim in the retranscribe error block) is ticket-05-shaped and
    **explicitly deferred** to that error-code follow-up; the frontend
    already mirrors the toast wording, so this is not a user-visible English
    surface on the cancel path.
- 2026-11-23 (implementer close-out): Ran, on Linux x86_64, after merging the
  `feat/native-i18n` tip: `cargo test -p samobranka --lib` → 767 pass / 0 fail
  / 7 ignored (`CARGO_TARGET_DIR=/home/timur/sources/tmp/cargo-target-ni-06`;
  `/tmp` ran out of space mid-run — moved off tmpfs); `cargo clippy -p
  samobranka --lib` → no new warnings in the touched files (4 pre-existing
  unused-import warnings in `build/ffmpeg.rs`, `lib.rs`, `diarization_run.rs`).
  Frontend (`bun test`, per-file): `native-progress` 12 pass,
  `native-progress-i18n` 5 pass, `native-progress-render` 9 pass,
  `i18n-parity` 5 pass, `i18n-usage` 11 pass, `import-audio-diarization` 6
  pass, `retranscribe-diarization-bar` 6 pass, `retranscribe-diarization-toast`
  3 pass, `swept-components-i18n` 7 pass. Full `bun test tests/`: 586 pass / 9
  fail — identical to the pre-change baseline (the known 9 cross-file
  `mock.module` leaks; verified by diffing the failure lists). `tsc --noEmit`:
  only the pre-existing `stage-transcribe-native.test.ts` TS7053 baseline
  error. **Untested:** the live app (`tauri:dev` not started per the
  consolidated GUI pass; to be exercised with a synthetic audio file in both
  languages, incl. the 1/2–4/5+ segment plural forms and the cancel toast).
- 2026-11-23 (review fix): **Shared progress vocabulary extracted to
  `audio/progress_codes.rs`.** The duplicated `CODE_*` block (decoding_file,
  converting_format, detecting_segments[_progress], loading_engine,
  transcribing_segment, writing_files, complete) and the identical
  decode/resample forward-progress-closure shape both lived twice, verbatim,
  in `import.rs` and `retranscription.rs`. They now live once in
  `progress_codes.rs`, modelled on `src/error_codes.rs`: the shared consts keep
  the `CODE_` prefix so the frontend pinning regex sees them in the new file,
  and `forward_decode_progress` + `band_percent` + the
  `detecting_segments_*`/`transcribing_segment_*` message/params builders pin
  the English fallback prose byte-for-byte (new Rust unit tests assert the
  exact pre-extraction wire strings). Each file keeps only its own codes
  (import: creating_folder/copying_file/creating_meeting; retranscription:
  saving_transcripts). Wire values are unchanged;
  `tests/lib/native-progress-i18n.test.ts` now extracts the consts from all
  three files and checks the shared set against BOTH namespaces.
