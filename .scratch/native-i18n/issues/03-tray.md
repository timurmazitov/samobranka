# Localize the tray menu

Status: ready-for-human
Type: task
Blocked by: 01, 02

## Context

`spec.md` D1, D4, D5 and the governing rule. This is the only one of the three
reported surfaces that *must* be localized in Rust: the menu is drawn by the OS,
so React never sees it.

All labels are inline English literals in `build_menu` at
`frontend/src-tauri/src/tray.rs:321-397`:

| Line | Current label |
| --- | --- |
| 331 | `⏳ Downloading transcription model...` (disabled) |
| 339 | `Start Recording` |
| 343 | `🔄 Starting Recording...` (disabled) |
| 350 | `⏸ Pause Recording` |
| 351, 360, 368, 377 | `⏹ Stop Recording` |
| 356 | `⏸ Pausing...` |
| 365 | `▶ Resume Recording` |
| 373 | `▶ Resuming...` |
| 381 | `⏹ Stopping...` |
| 391 | `Open Main Window` |
| 392 | `Settings` |
| 393 | `Check for Updates` |
| 395 | `Quit` |

`.tooltip("Samobranka")` at `tray.rs:27` is a brand name — leave it (glossary).

## Work

1. Add a `TrayStrings` struct in `l10n/` with one field per distinct label
   (`stop_recording` repeats four times: one field), plus keys in `en.json` /
   `ru.json` **without** the emoji prefixes.
2. `build_menu` takes the current language from managed state (ticket 02) and
   resolves the struct once; Rust prepends the glyph, so catalog values are
   `Pause Recording` / `Пауза записи` and the `⏸ ` is code (spec D5).
   Keep the exact existing emoji per state.
3. `update_tray_menu` / `update_tray_menu_async` (`tray.rs:298-317`) already
   rebuild and call `tray.set_menu(Some(menu))` on every state change
   (`recording_commands.rs:163, 699, 947, 1272, 1317, 1351`; `lib.rs:237, 283, 321`),
   and the tray is fetched by id (`tray_by_id("main-tray")`), not stored — so no
   new plumbing is needed. Just make the listener from ticket 02 call
   `update_tray_menu`.
4. Russian wording per spec Vocabulary: «Начать запись», «Пауза записи»,
   «Продолжить запись», «Остановить запись», «Открыть главное окно»,
   «Настройки», «Проверить обновления», «Выйти», and ellipsis-style progress
   items «Идёт запись…», «Запускается…», «Постановка на паузу…»,
   «Возобновление…», «Остановка…», «Загрузка модели транскрибации…».
   Match the register rules (neutral, sentence case, perfective imperative for
   actions).

## Acceptance

Run in `pnpm run tauri:dev` (a bare Next server does not exercise the tray —
`AGENTS.md`):

- Every menu state renders in Russian and in English: stopped, starting,
  recording, pausing, paused, resuming, stopping, plus the disabled
  "downloading model" state (`can_record == false`).
- Switching language in Settings → General retranslates the tray **live**, in
  both directions, no restart.
- Menu still functional after switching: `toggle_recording`, `pause_recording`,
  `resume_recording`, `stop_recording`, `open_window`, `settings`,
  `check_updates`, `quit` all still fire — the migration must not touch item ids.
- Checked on a Linux desktop (emoji glyph rendering differs across DEs and is
  the likeliest visual regression). Report the DE and what was observed.

## Acceptance status

Implemented (unit-tested headless in `frontend/src-tauri/src/tray.rs` and
`l10n/language.rs`):

- [x] `TrayStrings` (ticket 01) drives every label; `build_menu` resolves it
  once per call from managed `AppLanguageState` (`tray_menu_items` is the pure
  label/glyph/id/enabled resolver; `build_menu` is a thin `MenuItem` builder).
- [x] Glyphs ⏳/🔄/⏸/⏹/▶ prepended by Rust as constants (spec D5); catalog
  values emoji-free; English labels pinned to the exact pre-localization
  literals (`english_menu_labels_keep_the_pre_localization_literals_with_glyphs`).
- [x] `.tooltip("Samobranka")` untouched (brand).
- [x] Ticket-02 listener spot wired: `listen_language_changed` calls
  `tray::update_tray_menu` after an applied change; rejected payloads do not
  trigger a rebuild. Tray fetched by id — no new plumbing.
- [x] Item ids (`toggle_recording`, `pause_recording`, `resume_recording`,
  `stop_recording`, `open_window`, `settings`, `check_updates`, `quit`)
  unchanged in every state and both languages; disabled items carry no id
  (`item_ids_survive_localization_in_every_state`).
- [x] Russian wording matches the ticket list (ellipsis-style progress items);
  `ru.json` progress values were corrected from ticket 01's drafts
  («Запуск записи...» → «Запускается…», «Приостановка...» →
  «Постановка на паузу…», `...` → `…` throughout). Note: the ticket also
  lists «Идёт запись…», but no menu state renders it (Recording shows Pause +
  Stop), so no catalog key was added — the 13-field `TrayStrings` +
  `deny_unknown_fields` parity test stays green.

Manual `tauri:dev` matrix (deferred to the consolidated GUI pass):

- [ ] Every menu state renders in Russian and in English: stopped, starting,
  recording, pausing, paused, resuming, stopping, plus the disabled
  "downloading model" state (`can_record == false`).
- [ ] Switching language in Settings → General retranslates the tray **live**,
  in both directions, no restart.
- [ ] Menu still functional after switching: `toggle_recording`,
  `pause_recording`, `resume_recording`, `stop_recording`, `open_window`,
  `settings`, `check_updates`, `quit` all still fire.
- [ ] Checked on a Linux desktop (emoji glyph rendering differs across DEs and
  is the likeliest visual regression). Report the DE and what was observed.

## Comments

- 2026-11-23 (ticket 03 implementation): branch `feat/ni-03` (based on
  `feat/native-i18n` with tickets 01, 02, 04, 06, 07, 08, 09 merged), commit
  on top of the tip `c039da2` (native-i18n: тикет 03 — трей-меню локализуется
  из каталога l10n). Reused ticket 01's `TrayStrings`/catalogs and ticket 02's
  `AppLanguageState` + listener spot; nothing reimplemented.
  - `tray.rs`: `build_menu` split into pure `tray_menu_items(AppLanguage,
    RecordingState, can_record) -> Vec<TrayItemSpec>` + a thin build loop;
    language read at call time via `try_state::<AppLanguageState>()` (spec D4,
    no Lazy/OnceCell; warns and defaults to English if state is missing —
    guards only a misordered startup). Glyphs are `&'static str` constants.
  - `l10n/language.rs`: `handle_language_changed` now returns
    `Option<AppLanguage>` (the applied change), and `listen_language_changed`
    calls `crate::tray::update_tray_menu` on `Some` — the ticket-02 spot. The
    spawned refresh task needs the store plugin, so the listener tests build
    their mock app with `tauri_plugin_store` (the real app installs it in
    `run()`); `update_tray_menu_async` is additionally exercised headless with
    no tray registered (logs and returns; `check_can_record` degrades to
    false without onboarding/model manager).
  - Ran: `cargo test -p samobranka --lib` — 774 pass / 0 fail / 7 ignored
    (after merging the `feat/native-i18n` tip c039da2 into this branch; 772
    pass before that merge), `CARGO_TARGET_DIR=/home/timur/sources/tmp/
    cargo-target-ni-03`, Linux x86_64, sidecars staged. `cargo clippy -p
    samobranka --lib --tests` — no new warnings in the touched files
    (pre-existing warnings elsewhere, incl. ticket 01's `l10n/mod.rs`
    `needless_lifetimes`, left as-is).
  - Untested (consolidated GUI pass owns these): the 8-state x 2-language
    manual matrix in `pnpm run tauri:dev`, live re-translation both ways
    without restart, menu items firing after a switch, and the Linux DE
    emoji-glyph check — the tray cannot be built under `MockRuntime`
    (`TrayIconBuilder` needs a real event loop), so end-to-end rendering and
    `set_menu` after a language event are unverified here. DE check pending.
