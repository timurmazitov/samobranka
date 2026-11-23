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

- With UI language Russian: the four microphone toasts, and the Undo/Redo
  tooltips, render in Russian. Reproduce a microphone switch and a fallback
  failure to see them; if a real failure is hard to trigger, say so in the report
  rather than claiming coverage.
- `i18n-parity` and `i18n-usage` pass, and `i18n-usage` **fails on purpose** when
  an English literal is reintroduced in one of the three guarded shapes.
- Report exactly which microphone paths were exercised in `tauri:dev` and which
  were only unit-tested (`AGENTS.md` verification rule).
