# Bridge the UI language into Rust

Status: ready-for-agent
Type: task
Blocked by: 01

## Context

`spec.md` D3, D4. The frontend already persists the chosen language to
`preferences.json` in the app config dir through `@tauri-apps/plugin-store`,
key `app_language` — see `frontend/src/lib/app-language.ts:16-17`. The comment
at `app-language.ts:6-9` says the file lives there *specifically* so Rust could
read it. Nothing does yet: grepping `app_language` / `preferences.json` in
`src-tauri` finds only the unrelated `recording_preferences.json`.

## Work

1. At startup, before the tray is built (`lib.rs:582` calls
   `tray::create_tray(_app.handle())`), read `app_language` via
   `tauri_plugin_store::StoreExt` — precedent:
   `frontend/src-tauri/src/audio/recording_preferences.rs:290`
   (`app.store("recording_preferences.json")`).
2. **Absent-key path** (first run: `loadAppLanguage()` at `app-language.ts:25-34`
   returns `null` and writes nothing until the user touches the picker): fall
   back to the OS locale through `l10n::normalize`. Pick the locale source during
   implementation — prefer avoiding a new dependency (`@tauri-apps/plugin-os` has
   no Rust half installed here; consider `tauri::Manager` locale facility or
   `sys-locale`).
3. Keep the active value in shared state (`app.manage(...)`), **not** in a
   `Lazy`/`OnceCell` — `tray.rs` caches nothing today and must not start
   (spec D4).
4. Emit `app-language-changed` from
   `frontend/src/contexts/LanguageContext.tsx:77-89` (`setLanguage`), which
   already does `changeLanguage` → `saveAppLanguage` → `<html lang>` → title.
   Rust listens and updates the managed value. No new command, no restart prompt.

## Acceptance

- A fresh profile on a `ru` system starts with the Rust side resolved to
  `ru`; on any other locale, `en`.
- A stored `app_language` wins over the OS locale, both directions.
- Changing the language in Settings → General updates the managed Rust value
  without a restart (verify by logging or by ticket 03's tray; the value alone
  is the deliverable here).
- Rust and the frontend never disagree on the resolved language for the same
  input; assert the shared cases in a test.

## Notes

The frontend resolves from `navigator.language`; Rust resolves from the OS
locale. These can legitimately differ from the webview's locale — the stored
value is what makes them agree, so the absent-key test matters (spec D11).

## Acceptance status

- [x] Stored `app_language` wins over the OS locale, both directions
  (`l10n/language.rs` `resolve_language` tests + the shared case vector).
- [x] Absent key → OS locale: `ru`-family → `ru`, anything else → `en`
  (`first_run_follows_the_os_locale`, rows in `SHARED_RESOLUTION_CASES`).
- [x] Rust and the frontend never disagree on the same input:
  `frontend/tests/lib/app-language-parity.test.ts` parses
  `SHARED_RESOLUTION_CASES` out of `l10n/language.rs` and runs every row
  through `resolveAppLanguage` (the frontend twin of `resolve_language`), and
  pins the store file/key and the event-name literals on both sides.
- [ ] Live switch in the running app (Settings → General updates the managed
  value without restart) — listener and emit are unit-tested on both sides
  (`listen_language_changed_routes_events_into_the_managed_state`,
  `language-emit.test.tsx`); the end-to-end check happens in ticket 03's
  consolidated `tauri:dev` tray pass.

## Comments

- 2026-11-23 (feat/ni-02): Implemented.
  - `frontend/src-tauri/src/l10n/language.rs` (new submodule of `l10n`):
    `AppLanguageState` (managed, internally-mutable cell — Tauri's
    `StateManager` cannot replace a managed value after insertion),
    `resolve_language(stored, os)` (stored exact-code gate mirroring
    `isAppLanguage`, then `l10n::AppLanguage::normalize` on the OS tag),
    `resolve_at_startup` via `tauri_plugin_store::StoreExt` reading
    `preferences.json` / `app_language`, `handle_language_changed` +
    `listen_language_changed` (a single call site for ticket 03 to add the
    tray rebuild), and `init_app_language` wiring both from `setup()` before
    `tray::create_tray` (`lib.rs`).
  - **New dependency**: `sys-locale = "0.3"` (0.3.2). Approved path per
    ticket/spec D3: tauri 2.11 exposes no Rust locale API and the Rust half
    of `tauri-plugin-os` is not installed; `sys-locale` is a bare locale
    probe, not an i18n dialect crate, so D10 is not violated. Probing is
    isolated in `os_locale()` so the resolution logic stays injectable.
  - Frontend: `APP_LANGUAGE_CHANGED_EVENT` + `resolveAppLanguage` added
    (`app-language.ts`, `i18n/index.ts`); `LanguageProvider` resolves through
    `resolveAppLanguage` and `setLanguage` emits the event (dynamic import
    guarded on `__TAURI_INTERNALS__`, same pattern as `app-window-title.ts`;
    emitted even when the store save fails).
  - Ran (after merging the `feat/native-i18n` tip into this branch):
    `cargo test -p samobranka --lib` — 765 pass / 0 fail / 7 ignored
    (`CARGO_TARGET_DIR=/tmp/opencode/target-ni-02`, Linux x86_64);
    `cargo clippy -p samobranka --lib` — no new warnings in the touched
    files. `bun test` per file: `app-language-parity` 4 pass,
    `language-emit` 2 pass, `language-window-title` 2 pass,
    `i18n-parity` 5 pass, `i18n-usage` 3 pass. Full `bun test tests/`:
    560 pass / 9 fail — the same 9 known cross-file `mock.module` leaks as
    the pre-change baseline run (identical failure list), the additional
    passes being this ticket's and the merged tickets' new tests.
    `tsc --noEmit`: only the pre-existing `stage-transcribe-native.test.ts`
    TS7053 baseline error.
  - Untested: the running app (`tauri:dev` not started per the consolidated
    GUI pass; live tray/menu re-localization is ticket 03), and OS-locale
    probing on non-Linux hosts (`sys-locale` code paths unexercised here).
