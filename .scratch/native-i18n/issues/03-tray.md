# Localize the tray menu

Status: ready-for-agent
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
