//! Native (Rust-owned) interface localization.
//!
//! This module owns the strings that only Rust renders — the OS tray menu,
//! native dialogs, system notifications. Strings that travel to the frontend as
//! data are localized by the frontend via `t()` (see the native-i18n spec,
//! "Governing rule"); this module is deliberately small.
//!
//! Design (spec D1/D2/D10):
//! - Catalogs are Rust-owned nested JSON in `frontend/src-tauri/locales/`,
//!   embedded with [`include_str!`] so unit tests need no runtime file IO.
//!   English is the key-existence source of truth and the runtime fallback.
//! - One typed struct per surface ([`TrayStrings`]); a missing catalog field is a
//!   load error, so parity between the catalog and the struct is enforced by a
//!   unit test rather than by `build.rs` codegen.
//! - Russian plurals use the same CLDR suffixes i18next uses
//!   (`_one`/`_few`/`_many`/`_other`); see [`Plural`] and [`PluralForms`].
//!
//! No i18n crate is introduced (spec D10): the format stays compatible with the
//! frontend's `translation.json` files so the parity discipline is trivial.

use serde::Deserialize;

/// The supported interface languages, mirroring `AppLanguageCode` in
/// `frontend/src/i18n/languages.ts`. Only English and Russian exist today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppLanguage {
    En,
    Ru,
}

impl AppLanguage {
    /// The BCP-47 primary subtag, matching the frontend language codes.
    pub fn as_code(self) -> &'static str {
        match self {
            AppLanguage::En => "en",
            AppLanguage::Ru => "ru",
        }
    }

    /// Maps an arbitrary locale tag (`ru-RU`, `ru_RU`, `en-GB`, …) onto a
    /// supported language, mirroring `normalizeAppLanguage` in
    /// `frontend/src/i18n/index.ts:49-53` exactly: an empty/absent tag, or a
    /// primary subtag that is not Russian, resolves to English.
    pub fn normalize(tag: Option<&str>) -> AppLanguage {
        // Mirror `normalizeAppLanguage`: a missing/empty tag resolves to English;
        // otherwise lowercase, `_`->`-`, take the primary subtag. Anything that is
        // not Russian (including `en` and unknown tags) resolves to English.
        let tag = match tag {
            Some(t) if !t.is_empty() => t,
            _ => return AppLanguage::En,
        };
        let normalized = tag.to_lowercase().replace('_', "-");
        let primary = normalized.split('-').next().unwrap_or("");
        match primary {
            "ru" => AppLanguage::Ru,
            _ => AppLanguage::En,
        }
    }
}

/// CLDR plural category, using the same suffixes i18next uses for Russian.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Plural {
    One,
    Few,
    Many,
    /// Reserved for fractional counts and as the loader's last-resort fallback;
    /// integer counts (the only ones produced here) never select it.
    #[allow(dead_code)]
    Other,
}

impl Plural {
    /// The i18next key suffix for this category (`_one`, `_few`, …).
    pub fn suffix(self) -> &'static str {
        match self {
            Plural::One => "_one",
            Plural::Few => "_few",
            Plural::Many => "_many",
            Plural::Other => "_other",
        }
    }

    /// The CLDR plural category for an integer count, per the Russian rules.
    pub fn category(count: i64) -> Plural {
        // CLDR ru, integer operands: n10 == 1 && n100 != 11 -> one;
        // n10 in 2..=4 && n100 not in 11..=14 -> few; otherwise many.
        let n10 = count.abs() % 10;
        let n100 = count.abs() % 100;
        if n10 == 1 && n100 != 11 {
            Plural::One
        } else if (2..=4).contains(&n10) && !(11..=14).contains(&n100) {
            Plural::Few
        } else {
            Plural::Many
        }
    }
}

/// The four plural variants of one string, keyed by CLDR category. Built by a
/// surface loader from `<base>_one`/`_few`/`_many`/`_other` catalog keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PluralForms<'a> {
    pub one: &'a str,
    pub few: &'a str,
    pub many: &'a str,
    pub other: &'a str,
}

impl<'a> PluralForms<'a> {
    /// Picks the variant that agrees with `count`.
    pub fn select(&self, count: i64) -> &'a str {
        match Plural::category(count) {
            Plural::One => self.one,
            Plural::Few => self.few,
            Plural::Many => self.many,
            Plural::Other => self.other,
        }
    }
}

/// Catalog section a surface loads from.
fn section<'a>(root: &'a serde_json::Value, name: &str) -> serde_json::Map<String, serde_json::Value> {
    root.get(name)
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

/// Tray menu labels, one field per menu item. Emoji prefixes are intentionally
/// excluded (spec D5): `tray.rs` prepends the glyph. Loaded from the catalog's
/// `tray` object; a missing or unknown field is a load error so the catalog and
/// this struct cannot drift.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TrayStrings {
    pub start_recording: String,
    pub starting_recording: String,
    pub pause_recording: String,
    pub pausing: String,
    pub resume_recording: String,
    pub resuming: String,
    pub stop_recording: String,
    pub stopping: String,
    pub downloading_model: String,
    pub open_main_window: String,
    pub settings: String,
    pub check_for_updates: String,
    pub quit: String,
}

const EN_JSON: &str = include_str!("../../locales/en.json");
const RU_JSON: &str = include_str!("../../locales/ru.json");

/// Parses an embedded catalog. English is the fallback; the fallback chain is
/// Rust -> English -> English (English must parse, or the catalog is broken).
fn catalog(lang: AppLanguage) -> serde_json::Value {
    let raw = match lang {
        AppLanguage::Ru => RU_JSON,
        AppLanguage::En => EN_JSON,
    };
    serde_json::from_str(raw).unwrap_or_else(|e| {
        panic!("l10n: {} catalog must be valid JSON: {e}", lang.as_code())
    })
}

impl TrayStrings {
    /// Loads the tray labels for `lang`, falling back to English if the
    /// requested catalog is missing or incomplete.
    pub fn load(lang: AppLanguage) -> TrayStrings {
        let from = |root: &serde_json::Value| -> Option<TrayStrings> {
            serde_json::from_value(section(root, "tray").into()).ok()
        };
        from(&catalog(lang))
            .or_else(|| from(&catalog(AppLanguage::En)))
            .expect("l10n: en tray catalog must contain every TrayStrings field")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- normalize (fallback table) -------------------------------------

    #[test]
    fn normalize_maps_locale_tags_to_supported_languages() {
        // Modelled on Handy's `resolves_locale_fallbacks`. Expected values are
        // hand-derived from `normalizeAppLanguage`, not recomputed by the code.
        let cases: &[(&str, AppLanguage)] = &[
            ("ru", AppLanguage::Ru),
            ("ru-RU", AppLanguage::Ru),
            ("ru_RU", AppLanguage::Ru),
            ("RU", AppLanguage::Ru),
            ("ru-ru", AppLanguage::Ru),
            ("en", AppLanguage::En),
            ("en-GB", AppLanguage::En),
            ("en_US", AppLanguage::En),
            ("xx-YY", AppLanguage::En),
            ("de", AppLanguage::En),
            ("", AppLanguage::En),
        ];
        for (tag, expected) in cases {
            assert_eq!(
                AppLanguage::normalize(Some(tag)),
                *expected,
                "normalize({tag:?})"
            );
        }
        assert_eq!(
            AppLanguage::normalize(None),
            AppLanguage::En,
            "normalize(None)"
        );
    }

    #[test]
    fn normalize_agrees_with_frontend_algorithm_on_edge_tags() {
        // The frontend splits on '-' after lowercasing and '_'->'-'; a leading
        // region-only tag has no Russian primary subtag and must be English.
        assert_eq!(AppLanguage::normalize(Some("RU-ru")), AppLanguage::Ru);
        assert_eq!(AppLanguage::normalize(Some("russian")), AppLanguage::En);
        assert_eq!(AppLanguage::normalize(Some("  ")), AppLanguage::En);
    }

    // ---- plural (CLDR table) --------------------------------------------

    #[test]
    fn plural_category_matches_russian_forms() {
        // Count -> (category, known-correct noun form) for "минута".
        let cases: &[(i64, Plural, &str)] = &[
            (1, Plural::One, "минута"),
            (2, Plural::Few, "минуты"),
            (5, Plural::Many, "минут"),
            (11, Plural::Many, "минут"),
            (21, Plural::One, "минута"),
            (22, Plural::Few, "минуты"),
            (25, Plural::Many, "минут"),
            (101, Plural::One, "минута"),
            (111, Plural::Many, "минут"),
        ];
        for (count, expected_category, expected_form) in cases {
            assert_eq!(
                Plural::category(*count),
                *expected_category,
                "category({count})"
            );
            let forms = PluralForms {
                one: "минута",
                few: "минуты",
                many: "минут",
                other: "минут",
            };
            assert_eq!(
                forms.select(*count),
                *expected_form,
                "select({count}) -> {expected_form}"
            );
        }
    }

    #[test]
    fn plural_suffixes_match_i18next_keys() {
        assert_eq!(Plural::One.suffix(), "_one");
        assert_eq!(Plural::Few.suffix(), "_few");
        assert_eq!(Plural::Many.suffix(), "_many");
        assert_eq!(Plural::Other.suffix(), "_other");
    }

    // ---- catalog parity + struct coverage -------------------------------

    /// Recursively collects every leaf key path in a catalog.
    fn leaf_keys(value: &serde_json::Value, prefix: String, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                for (k, v) in map {
                    let next = if prefix.is_empty() {
                        k.clone()
                    } else {
                        format!("{prefix}.{k}")
                    };
                    leaf_keys(v, next, out);
                }
            }
            _ => out.push(prefix),
        }
    }

    fn all_keys(raw: &str) -> Vec<String> {
        let value: serde_json::Value =
            serde_json::from_str(raw).expect("catalog must be valid JSON");
        let mut keys = Vec::new();
        leaf_keys(&value, String::new(), &mut keys);
        keys.sort();
        keys
    }

    #[test]
    fn en_and_ru_catalogs_have_identical_key_sets() {
        // Guards the same property i18n-parity.test.ts enforces on the frontend.
        let en = all_keys(EN_JSON);
        let ru = all_keys(RU_JSON);
        assert!(!en.is_empty(), "en catalog should not be empty");
        assert_eq!(en, ru, "en and ru catalog key sets must match");
    }

    #[test]
    fn every_tray_field_is_populated_in_both_languages() {
        // Destructuring makes a new TrayStrings field a compile error here, so
        // the coverage test cannot silently go stale.
        for lang in [AppLanguage::En, AppLanguage::Ru] {
            let t = TrayStrings::load(lang);
            let TrayStrings {
                start_recording,
                starting_recording,
                pause_recording,
                pausing,
                resume_recording,
                resuming,
                stop_recording,
                stopping,
                downloading_model,
                open_main_window,
                settings,
                check_for_updates,
                quit,
            } = &t;
            let values = [
                start_recording,
                starting_recording,
                pause_recording,
                pausing,
                resume_recording,
                resuming,
                stop_recording,
                stopping,
                downloading_model,
                open_main_window,
                settings,
                check_for_updates,
                quit,
            ];
            for v in values {
                assert!(
                    !v.trim().is_empty(),
                    "{:?} tray: a label is empty",
                    lang.as_code()
                );
            }
            // Emoji prefixes are excluded from the values (spec D5).
            for v in values {
                assert!(
                    !v.chars().any(|c| c == '⏸' || c == '⏹' || c == '▶' || c == '🔄' || c == '⏳'),
                    "{:?} tray: label must not embed an emoji prefix: {v:?}",
                    lang.as_code()
                );
            }
        }
    }

    #[test]
    fn tray_load_returns_catalog_values_for_both_languages() {
        // Both catalogs load fully; TrayStrings::load's fallback to English
        // (`.or_else(en)` after a failed ru parse) stays reachable as long as
        // `deny_unknown_fields` + no-default fields turn a missing/extra key
        // into a None, which is what feeds that fallback.
        let en = TrayStrings::load(AppLanguage::En);
        assert_eq!(en.quit, "Quit");
        let ru = TrayStrings::load(AppLanguage::Ru);
        assert_eq!(ru.quit, "Выйти");
    }
}
