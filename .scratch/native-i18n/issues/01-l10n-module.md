# Add the Rust l10n module

Status: resolved
Type: task

## Context

`spec.md` D1, D2, D10, D11. `frontend/src-tauri` has no i18n at all today: no
i18n crate in `Cargo.toml`, no `locales/`, no locale lookup. This ticket builds
the machinery only — no call sites, so it can land before any surface is
migrated.

Reference: Handy's `src-tauri/src/tray_i18n.rs`
(https://github.com/cjpais/Handy/blob/main/src-tauri/src/tray_i18n.rs) for the
typed-struct-per-surface shape and the fallback table test. We deliberately do
*not* copy its `build.rs` codegen from the frontend catalog — see spec D2.

## Work

1. `frontend/src-tauri/locales/en.json`, `ru.json` — nested JSON, English is the
   key-existence source of truth and the runtime fallback.
2. `frontend/src-tauri/src/l10n/mod.rs`:
   - a `Locale` (or `AppLanguage`) enum with `en` and `ru`, mirroring
     `frontend/src/i18n/languages.ts:17` — only these two;
   - `normalize(tag) -> Self`: lowercase, `_`→`-`, take the primary subtag, `ru`
     → Russian, anything else → English. Must equal
     `frontend/src/i18n/index.ts:49-53` (`normalizeAppLanguage`);
   - lookup into typed structs, one struct per surface, fields as `String`.
     Start with the minimum the tray needs — do not speculatively model
     notifications.
3. Plural helper (spec D10): category from a count using i18next's CLDR
   suffixes `_one`/`_few`/`_many`/`_other`. ~30 lines, no new dependency.
4. Register `mod l10n;` in `lib.rs`.

## Acceptance

- Unit tests: key sets identical between `en.json` and `ru.json` and covering
  every struct field; the fallback table (`ru-RU`, `ru_RU`, `RU`, `en-GB`,
  `xx-YY` → `en`, `None` → `en`) in the style of Handy's
  `resolves_locale_fallbacks`.
- Plural helper table-tested for `one/few/many/other` boundaries
  (1, 2, 5, 11, 21, 22, 25, 101, 111) against known Russian forms.
- `cargo test` passes for the crate. No existing behaviour changes.

## Notes

Do not add an i18n crate (`fluent`, `rust-i18n`, `gettext`) — spec D10.
