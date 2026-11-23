# Fix frontend English literals that bypass i18n

Status: ready-for-agent
Type: task

## Context

Not Rust, but the same user-visible bug from the user's point of view: "the app
is not translated". These are English literals written in the frontend, bypassing
`react-i18next`. They are cheap to fix, and they also reveal a hole in the repo's
own guard.

Confirmed literals:

- `frontend/src/contexts/RecordingStateContext.tsx:163`
  `'Starting recording...'`, `:171` and `:196` `'Stopping recording...'` —
  assigned to `statusMessage`. An earlier sweep reported `statusMessage` is
  **never read in JSX**; re-verify (ticket 08's discipline) and prefer deleting
  over localizing if it really is unrendered.
- `frontend/src/contexts/RecordingStateContext.tsx:295`
  `` `Microphone switched to ${label} for this meeting.` ``
- `:310` `` `Microphone fallback failed for ${label}: ${error}` ``
- `:323` `'No microphone available — recording system audio only.'`
- `:337` `` `Microphone '${label}' could not be recovered — recording continues
  without a microphone. Stop and restart to fix.` ``
- `frontend/src/components/AISummary/index.tsx:737` `title="Undo"`, `:758`
  `title="Redo"`.

Out of scope on purpose: `alt="Samobranka"` (`components/Logo.tsx:36,45`) and the
content-language display-name defaults in
`components/LanguageSelection.tsx:16-117` — the first is a brand, the second is
resolved through `contentLanguageName()` into the active UI language.

## Work

1. Move the four microphone toasts to keys
   (`t('recording.micSwitched', { label })`, …) with proper interpolation.
   Naming must keep `AGENTS.md`'s "microphone" / "system" role vocabulary, and
   the Russian wording must stay impersonal per the glossary register.
2. `${error}` at `:310` interpolates a **Rust** error string verbatim. Per spec
   D7 that tail stays raw: render it in a `params.detail`-style slot, translated
   prefix + untranslated technical tail. If the corresponding
   `mic-swap-failed` payload later gains a `code` (spec "Out of scope",
   `linux-audio-notice` group), that is a follow-up — do not expand this ticket.
3. Fix `Undo`/`Redo` tooltips to `t()` keys.
4. **Fix the guard**: `frontend/tests/lib/i18n-usage.test.ts` did not catch any
   of these. Investigate why (likely a component/hook allow-list, a pattern that
   only inspects JSX text and not `toast(...)` arguments or `title=` attributes,
   or this file being outside the swept set) and extend it so these three shapes
   are caught: non-`t()` string literals passed to toast helpers, `title=`
   attributes, and `statusMessage` assignments. Add a regression case.
5. For `statusMessage`: if it is genuinely unrendered, delete the literals and
   record that here; if something renders it, localize it and make the guard
   cover it.

## Acceptance

- [ ] With UI language Russian: the four microphone toasts, and the Undo/Redo
  tooltips, render in Russian. Reproduce a microphone switch and a fallback
  failure to see them; if a real failure is hard to trigger, say so in the report
  rather than claiming coverage.
- [x] `i18n-parity` and `i18n-usage` pass, and `i18n-usage` **fails on purpose** when
  an English literal is reintroduced in one of the three guarded shapes.
- [x] Report exactly which microphone paths were exercised in `tauri:dev` and which
  were only unit-tested (`AGENTS.md` verification rule).

## Comments

- 2026-11-23 (feat/ni-09, impl): **statusMessage deleted, not localized.**
  Re-verified per ticket 08's discipline: `statusMessage` is written only inside
  `RecordingStateContext.tsx` and read by nothing — no JSX renders it and no
  consumer of `useRecordingState()` touches it (the `...state` spread exposes
  it, but no caller uses it). The three English literals (`'Starting
  recording...'`, `'Stopping recording...'` ×2) were deleted with the field;
  `setStatus`'s now-console-only `message` parameter and the three call sites
  in `useRecordingStart`/`useRecordingStop` (including the never-rendered
  `TRANSCRIPTION_RUNTIME_USER_MESSAGE` const) went with it. The guard still
  covers the `statusMessage:` assignment shape, so a reintroduced literal
  fails CI.
- 2026-11-23 (feat/ni-09, impl): **Undo/Redo are inside a commented-out JSX
  block** (`AISummary/index.tsx` `{/* … */}` spanning the old 725–816), i.e.
  dead code the ticket mis-reported as live tooltips. Converted to
  `t('summary.ai.undo')` / `t('summary.ai.redo')` anyway so a restored toolbar
  renders localized; they render nothing today, in either language.
- 2026-11-23 (feat/ni-09, impl): four mic toasts moved to `recording.micSwitched`,
  `recording.micFallbackFailed` (`{ label, error }`, Rust tail raw per D7),
  `recording.micUnavailable`, `recording.micRecoveryExhausted`; `i18n.t` at
  emit time (listeners mount once, so per-render `t` would pin the language).
  Ru wording impersonal, sentence case, «микрофон»/«системный звук» per
  AGENTS.md. Two extra literals the extended guard surfaced and that shipped
  English: `useMeetingOperations.ts` `'Failed to open recording folder'` →
  `toasts.meetingFolder.openFailed`, and `AudioLevelMeter.tsx` title
  `'Active'/'Inactive'` → `devices.meterActive/meterInactive`. en+ru keys added
  with parity (guarded by `i18n-parity`).
- 2026-11-23 (feat/ni-09, impl): **guard root cause.** `i18n-usage.test.ts`
  only collected literal keys inside `t(...)`/`i18n.t(...)` calls and checked
  they exist in both catalogs — a *usage-vs-catalog* test. There was no scan of
  non-`t()` literals at all (no allow-list, no pattern bug): a string that
  never reaches `t()` was invisible by design. Extended: pure `scanSource()`
  flags prose literals in the first argument of `toast`/`toast.{error,info,…}`,
  in `title="…"`/`title={…}` attributes (incl. template-literal static
  segments and quoted literals inside `${…}`), and in `statusMessage:`
  assignments; `t()`-headed expressions, catalog keys, technical fragments and
  Tailwind class lists are exempt; `i18n-usage-allow` end-of-line marker
  exempts deliberate literals. Regression fixtures per shape (the exact
  missed strings) run `scanSource` on in-memory sources, so a neutered scan
  fails even when `src/` looks clean.
- 2026-11-23 (feat/ni-09, impl): ran (Linux, bun 1.4.4, from `frontend/`):
  `bun test tests/lib/i18n-parity.test.ts tests/lib/i18n-usage.test.ts` →
  16 pass; `tests/components/recording-state-mic-toasts.test.tsx` (new: real
  provider, mocked Tauri bus, fires all four mic events, asserts catalog text
  in en+ru and raw Rust tail) → 3 pass; touched-file suites (shutdown,
  live-stop-speaker-stage, live-recording-diarization, recording-start,
  meeting-rename-export, copy-export, panel-meeting-date,
  legacy-summary-export-date, swept-components) → pass. Full `bun test`: same
  9 pre-existing failures as at the base commit and as in the main checkout
  (`meeting-rename-export` ×6 via unmocked `plugin:app|version`,
  `app-window-title` ×2, 1 unnamed) — not caused by this ticket.
  Reintroduction demo done in-loop: English literals back in all three shapes
  → guard failed with each flagged; removal → green.
- 2026-11-23 (feat/ni-09, impl): **not exercised in `tauri:dev`** (parent
  directive: consolidated GUI verification later). All four microphone toast
  paths and both meter tooltips are unit-tested only; a real mic hot-unplug /
  fallback-failure walk-through in Russian is still owed.
