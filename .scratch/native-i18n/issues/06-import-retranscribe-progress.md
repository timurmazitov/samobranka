# Localize import and retranscription progress messages

Status: ready-for-agent
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

- Running an import and a retranscription in Russian shows every phase in
  Russian, with correct plural forms for 1 / 2–4 / 5+ segments and correct
  decimal separators.
- An unknown `code` falls back to the English `message`, never blank.
- Cancelling mid-run still shows a sensible message (`"Import cancelled"` /
  `"Retranscription cancelled"` come through `ImportError`/`RetranscriptionError`,
  which is ticket-05-shaped coding — cover or explicitly defer).
- `i18n-parity`, `i18n-usage`, `cargo test` pass; verified in `tauri:dev` on a
  real synthetic audio file (no private recordings in reports).
