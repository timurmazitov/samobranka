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
