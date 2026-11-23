//! Which interface language the Rust side renders in (native-i18n ticket 02).
//!
//! Resolution order mirrors the frontend exactly (spec D3): the stored
//! `app_language` from `preferences.json` wins; with no usable stored value,
//! the OS locale decides through [`AppLanguage::normalize`]; with neither,
//! English. The frontend persists the value through
//! `@tauri-apps/plugin-store` in `frontend/src/lib/app-language.ts`; Rust only
//! reads it, so `preferences.json` has exactly one writer.
//!
//! Live switching (spec D4): `LanguageContext.setLanguage` emits
//! `app-language-changed` with the bare code; [`listen_language_changed`]
//! registers the Rust listener that updates the managed [`AppLanguageState`].
//! The value lives in `app.manage`, not in a `Lazy`/`OnceCell` — `tray.rs`
//! caches nothing and must not start.

use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

use super::AppLanguage;

/// The key the frontend writes the interface language to, and the store file
/// it lives in — must match `frontend/src/lib/app-language.ts:16-17`
/// (`STORE_FILE` / `SETTING_KEY`).
pub const PREFERENCES_STORE_FILE: &str = "preferences.json";
pub const APP_LANGUAGE_KEY: &str = "app_language";

/// The event `LanguageContext.setLanguage` emits on every language switch
/// (spec D4). Payload: a JSON string with the language code, e.g. `"ru"`.
pub const LANGUAGE_CHANGED_EVENT: &str = "app-language-changed";

/// The shared case vector both sides test against: `(stored, os_locale,
/// expected_code)`, where `""` means "absent" for the first two. The frontend
/// test `frontend/tests/lib/app-language-parity.test.ts` parses this const out
/// of this file and asserts `normalizeAppLanguage` agrees on every row — the
/// same discipline `live-diarization.test.ts` applies to the mirrored native
/// texts. Expected values are hand-derived from the frontend algorithm
/// (`frontend/src/i18n/index.ts:49-53` plus the stored-wins rule), not
/// computed by either implementation.
pub const SHARED_RESOLUTION_CASES: &[(&str, &str, &str)] = &[
    // A stored choice wins over the OS locale in both directions.
    ("ru", "en-US", "ru"),
    ("en", "ru-RU", "en"),
    ("ru", "ru-RU", "ru"),
    ("en", "en-US", "en"),
    ("ru", "", "ru"),
    ("en", "", "en"),
    // Absent stored value: the OS locale decides (first run).
    ("", "ru", "ru"),
    ("", "ru-RU", "ru"),
    ("", "ru_RU", "ru"),
    ("", "en-US", "en"),
    ("", "de-DE", "en"),
    ("", "", "en"),
    // A stored value the frontend would reject (`isAppLanguage` is exact)
    // counts as absent, and the OS locale decides.
    ("RU", "en-US", "en"),
    ("ru-RU", "", "en"),
    ("de", "ru-RU", "ru"),
    ("", "RU", "ru"),
    ("", "russian", "en"),
];

/// The active language, kept in shared app state per spec D4
/// (`app.manage(AppLanguageState::new(..))` in `run()`'s `setup()`).
///
/// Tauri's `StateManager` cannot replace a value once inserted, so the cell is
/// internally mutable; reads and writes are one `Mutex` hop and contention is
/// nil (only the tray build and the one listener touch it).
#[derive(Debug)]
pub struct AppLanguageState(Mutex<AppLanguage>);

impl AppLanguageState {
    pub fn new(language: AppLanguage) -> Self {
        Self(Mutex::new(language))
    }

    /// The current language. Poisoned-lock recovery: the only thing ever
    /// stored is a `Copy` enum, so a panic while writing cannot leave a torn
    /// value worth failing on.
    pub fn get(&self) -> AppLanguage {
        *self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn set(&self, language: AppLanguage) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = language;
    }
}

/// Extracts the stored language from the raw `serde_json::Value` the store
/// holds under [`APP_LANGUAGE_KEY`], reproducing the frontend's gate at
/// `frontend/src/lib/app-language.ts:25-34`: only the exact codes `"en"` and
/// `"ru"` are a stored choice; everything else (absent, wrong type, `"RU"`,
/// `"ru-RU"`) behaves as if the key were missing, letting the OS locale
/// decide. Returns the tag so callers can distinguish "no key" from "bad
/// value" for logging; [`resolve_language`] applies the gate itself.
pub fn stored_language_value(raw: Option<Value>) -> Option<String> {
    raw.and_then(|v| v.as_str().map(str::to_owned))
}

/// Resolves the language from the two inputs with the precedence the frontend
/// uses (spec D3): a usable stored choice wins in both directions; otherwise
/// the OS locale goes through [`AppLanguage::normalize`]; with neither,
/// English. Both inputs are `None` for "absent"; empty strings are treated as
/// absent too, matching the store's absence of a usable value.
pub fn resolve_language(stored: Option<&str>, os_locale: Option<&str>) -> AppLanguage {
    let stored = stored.filter(|s| !s.is_empty());
    if let Some(tag) = stored {
        // Exact-code gate mirroring `isAppLanguage` in
        // `frontend/src/i18n/index.ts:41-43` — case-sensitive, only the two
        // full codes. Anything else falls through to the OS locale, exactly
        // like `loadAppLanguage` returning null.
        match tag {
            "en" => return AppLanguage::En,
            "ru" => return AppLanguage::Ru,
            _ => {}
        }
    }
    AppLanguage::normalize(os_locale.filter(|s| !s.is_empty()))
}

/// The OS locale tag, or `None` when the system does not report one.
///
/// `sys-locale` is a bare locale probe, not an i18n dialect crate (spec D10
/// forbids `fluent`/`rust-i18n`-style catalogs, not a locale getter). It is
/// needed because tauri 2.11 exposes no Rust locale API and the Rust half of
/// `tauri-plugin-os` is not installed in this workspace — see the comment at
/// `frontend/src/contexts/LanguageContext.tsx:40`. Kept as its own thin
/// function so the resolution logic above stays testable without a host.
pub fn os_locale() -> Option<String> {
    sys_locale::get_locale()
}

/// Reads `app_language` from `preferences.json` and resolves the startup
/// language (spec D3). A store that cannot be opened behaves like the absent
/// key: the OS locale decides, and English decides if it cannot be read —
/// startup must never fail over a language probe.
pub fn resolve_at_startup<R: Runtime>(app: &AppHandle<R>) -> AppLanguage {
    use tauri_plugin_store::StoreExt;

    let raw = match app.store(PREFERENCES_STORE_FILE) {
        Ok(store) => store.get(APP_LANGUAGE_KEY),
        Err(e) => {
            log::warn!(
                "l10n: failed to open {PREFERENCES_STORE_FILE}: {e}; resolving from the OS locale"
            );
            None
        }
    };
    let stored = stored_language_value(raw);
    let os = os_locale();
    let language = resolve_language(stored.as_deref(), os.as_deref());
    log::info!(
        "l10n: startup language {} (stored={stored:?}, os_locale={os:?})",
        language.as_code()
    );
    language
}

/// Wires the interface language into shared app state at startup (spec D3/D4).
/// Call from `setup()` **before** `tray::create_tray` so the first menu build
/// can already read the resolved language from `AppLanguageState`.
///
/// Order matters only in that the state must be managed before the listener
/// can be reached by an event; both happen here, before the tray exists.
pub fn init_app_language<R: Runtime>(app: &AppHandle<R>) {
    let language = resolve_at_startup(app);
    app.manage(AppLanguageState::new(language));
    listen_language_changed(app);
}

/// Parses the `app-language-changed` payload: a JSON string with an exact
/// supported code, or `None` for anything else. Strict like the frontend's
/// `isAppLanguage`: `"de"` or `"RU"` must be ignored, not normalized to
/// English, so garbage never silently re-localizes the native surfaces.
fn parse_language_payload(payload: &str) -> Option<AppLanguage> {
    match serde_json::from_str::<String>(payload) {
        Ok(code) => match code.as_str() {
            "en" => Some(AppLanguage::En),
            "ru" => Some(AppLanguage::Ru),
            _ => None,
        },
        Err(_) => None,
    }
}

/// Handles one `app-language-changed` event: updates the managed state if the
/// payload is a supported code, ignores anything else. Public so the unit
/// test drives it directly with a payload string, mirroring what the listener
/// receives as `event.payload()`.
pub fn handle_language_changed<R: Runtime>(app: &AppHandle<R>, payload: &str) {
    let Some(language) = parse_language_payload(payload) else {
        log::warn!("l10n: ignored {LANGUAGE_CHANGED_EVENT} payload: {payload:?}");
        return;
    };
    if let Some(state) = app.try_state::<AppLanguageState>() {
        state.set(language);
        log::info!("l10n: interface language is now {}", language.as_code());
    } else {
        log::warn!("l10n: {LANGUAGE_CHANGED_EVENT} fired before the language state was managed");
    }
}

/// Registers the Rust listener for [`LANGUAGE_CHANGED_EVENT`] (spec D4).
/// Called once from `setup()` after the [`AppLanguageState`] is managed.
///
/// Ticket 03 adds the tray refresh here — a single `tray::update_tray_menu`
/// style call after the state update, so the menu re-localizes on switch.
pub fn listen_language_changed<R: Runtime>(app: &AppHandle<R>) {
    use tauri::Listener;

    let handle = app.clone();
    app.listen(LANGUAGE_CHANGED_EVENT, move |event| {
        handle_language_changed(&handle, event.payload());
        // Ticket 03: rebuild the tray menu here, reading AppLanguageState.
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- resolution (spec D3: stored wins, then OS locale, then en) ------

    #[test]
    fn resolve_language_follows_the_shared_case_vector() {
        // Expected codes are hand-written literals in the const above (spec
        // D11), not computed by the implementation; the frontend runs the same
        // vector against `normalizeAppLanguage`.
        for (stored, os, expected) in SHARED_RESOLUTION_CASES {
            let stored = if stored.is_empty() { None } else { Some(*stored) };
            let os = if os.is_empty() { None } else { Some(*os) };
            assert_eq!(
                resolve_language(stored, os).as_code(),
                *expected,
                "resolve_language(stored={stored:?}, os={os:?})"
            );
        }
    }

    #[test]
    fn a_stored_choice_wins_over_the_os_locale_in_both_directions() {
        // The acceptance case from the ticket, spelled out without the table:
        // a stored choice must never lose to the OS locale, whichever way the
        // two disagree.
        assert_eq!(resolve_language(Some("ru"), Some("en-US")), AppLanguage::Ru);
        assert_eq!(resolve_language(Some("en"), Some("ru-RU")), AppLanguage::En);
    }

    #[test]
    fn an_unusable_stored_value_falls_back_to_the_os_locale() {
        // Mirrors `loadAppLanguage` at `frontend/src/lib/app-language.ts:25-34`,
        // which returns null for anything that is not exactly 'en' or 'ru'
        // (case-sensitive `isAppLanguage`), so the OS locale decides.
        assert_eq!(resolve_language(Some("RU"), Some("en-US")), AppLanguage::En);
        assert_eq!(resolve_language(Some("de"), Some("ru-RU")), AppLanguage::Ru);
    }

    #[test]
    fn first_run_follows_the_os_locale() {
        // The absent-key path (spec D11: `preferences.json` with no
        // `app_language` at all): ru-family OS locale -> ru, anything else en.
        assert_eq!(resolve_language(None, Some("ru-RU")), AppLanguage::Ru);
        assert_eq!(resolve_language(None, Some("ru")), AppLanguage::Ru);
        assert_eq!(resolve_language(None, Some("en-US")), AppLanguage::En);
        assert_eq!(resolve_language(None, Some("de-DE")), AppLanguage::En);
        assert_eq!(resolve_language(None, None), AppLanguage::En);
    }

    #[test]
    fn stored_language_requires_a_json_string() {
        // The store hands the raw `serde_json::Value` for `app_language`; only
        // a JSON string can even be a stored choice. Non-strings behave like
        // the key was absent; the exact-code gate itself is resolve_language's
        // job and is covered by the shared vector.
        use serde_json::json;
        assert_eq!(stored_language_value(Some(json!("ru"))).as_deref(), Some("ru"));
        assert_eq!(stored_language_value(Some(json!("en"))).as_deref(), Some("en"));
        assert_eq!(stored_language_value(Some(json!("ru-RU"))).as_deref(), Some("ru-RU"));
        assert_eq!(stored_language_value(Some(json!(null))), None);
        assert_eq!(stored_language_value(Some(json!(42))), None);
        assert_eq!(stored_language_value(Some(json!({"code": "ru"}))), None);
        assert_eq!(stored_language_value(None), None);
    }

    // ---- live switching (spec D4) -----------------------------------------

    #[test]
    fn handle_language_changed_updates_the_managed_state() {
        // `LanguageContext.setLanguage` emits the bare code, which arrives as
        // a JSON string payload.
        let app = tauri::test::mock_app();
        app.manage(AppLanguageState::new(AppLanguage::En));

        handle_language_changed(app.handle(), "\"ru\"");
        assert_eq!(app.state::<AppLanguageState>().get(), AppLanguage::Ru);

        handle_language_changed(app.handle(), "\"en\"");
        assert_eq!(app.state::<AppLanguageState>().get(), AppLanguage::En);
    }

    #[test]
    fn handle_language_changed_ignores_payloads_that_are_not_a_supported_code() {
        // A malformed or unsupported payload must leave the managed value
        // untouched: normalizing garbage to English would silently switch the
        // native surfaces instead of keeping the working state.
        let app = tauri::test::mock_app();
        app.manage(AppLanguageState::new(AppLanguage::Ru));

        for payload in ["not json", "\"de\"", "42", "{}", "\"\"", "null", "\"RU\""] {
            handle_language_changed(app.handle(), payload);
            assert_eq!(
                app.state::<AppLanguageState>().get(),
                AppLanguage::Ru,
                "payload {payload:?} must be ignored"
            );
        }
    }

    #[test]
    fn listen_language_changed_routes_events_into_the_managed_state() {
        // The seam is the event itself: emit as the frontend does, and the
        // managed value must follow — the live-switch path of spec D4 without
        // a tray (ticket 03 adds the menu rebuild).
        use tauri::Emitter;

        let app = tauri::test::mock_app();
        app.manage(AppLanguageState::new(AppLanguage::En));
        listen_language_changed(app.handle());

        app.emit(LANGUAGE_CHANGED_EVENT, "ru").expect("emit reaches the listener");
        // The mock runtime dispatches synchronously on the emitting thread.
        assert_eq!(app.state::<AppLanguageState>().get(), AppLanguage::Ru);
    }

    #[test]
    fn state_survives_without_a_manager_entry_and_the_cell_reads_back() {
        // `get`/`set` round-trip, and an event before `manage` must not panic
        // (the listener is registered in setup() right after managing, but the
        // ordering must not be load-bearing for safety).
        let state = AppLanguageState::new(AppLanguage::En);
        state.set(AppLanguage::Ru);
        assert_eq!(state.get(), AppLanguage::Ru);

        let app = tauri::test::mock_app();
        handle_language_changed(app.handle(), "\"ru\""); // no state managed: just logged
    }
}
