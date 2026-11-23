use crate::audio::recording_commands::StopOutcome;
use crate::l10n::{language::AppLanguageState, AppLanguage, TrayStrings};
use tauri::{
    Emitter,
    menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};

#[derive(Debug, Clone)]
pub enum RecordingState {
    Stopped,
    Starting,
    Recording,
    Pausing,
    Paused,
    Resuming,
    Stopping,
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // Start with default menu, will update with actual state after initialization
    // Pass can_record=true initially, will be updated by update_tray_menu immediately
    let menu = build_menu(app, RecordingState::Stopped, true)?;

    TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("Samobranka")
        .icon(app.default_window_icon().unwrap().clone())
        .on_menu_event(|app, event| handle_menu_event(app, event.id.as_ref()))
        .build(app)?;

    // Update tray menu with actual recording state after creation
    update_tray_menu(app);

    Ok(())
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, item_id: &str) {
    match item_id {
        "toggle_recording" => toggle_recording_handler(app),
        "pause_recording" => pause_recording_handler(app),
        "resume_recording" => resume_recording_handler(app),
        "stop_recording" => stop_recording_handler(app),
        "open_window" => focus_main_window(app),
        "settings" => {
            focus_main_window(app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval("window.location.assign('/settings')");
            }
        }
        "check_updates" => check_updates_handler(app),
        "quit" => app.exit(0),
        _ => {}
    }
}
fn toggle_recording_handler<R: Runtime>(app: &AppHandle<R>) {
    focus_main_window(app);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if crate::is_recording().await {
            // Immediately show stopping state
            set_tray_state(&app_clone, RecordingState::Stopping);

            log::info!("Tray toggle: Stopping recording...");

            // Generate save path (same as RecordingControls.tsx)
            let data_dir = match app_clone.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    log::error!("Failed to get app data dir: {}", e);
                    update_tray_menu_async(&app_clone).await;
                    return;
                }
            };

            let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
            let save_path = data_dir.join(format!("recording-{}.wav", timestamp));

            // Call Rust stop_recording command (like pause/resume pattern)
            let stop_result = crate::audio::recording_commands::stop_recording(
                app_clone.clone(),
                crate::audio::recording_commands::RecordingArgs {
                    save_path: save_path.to_string_lossy().to_string(),
                },
            )
            .await;

            // Handle result
            match stop_result {
                Ok(StopOutcome::Stopped) => {
                    log::info!("Tray toggle: Recording stopped successfully");

                    // Trigger frontend post-processing via event (works from any page)
                    // (SQLite save, navigation)
                    if let Err(e) = app_clone.emit("recording-stop-complete", true) {
                        log::error!("Tray toggle: Failed to emit recording-stop-complete event: {}", e);
                    }
                }
                Ok(StopOutcome::AlreadyStopping) => {},
                Ok(StopOutcome::NotActive) => update_tray_menu_async(&app_clone).await,
                Err(e) => {
                    log::error!("Tray toggle: Failed to stop recording: {}", e);
                    // Revert tray state on error
                    update_tray_menu_async(&app_clone).await;
                }
            }
        } else {
            // Immediately show starting state
            set_tray_state(&app_clone, RecordingState::Starting);

            log::info!("Emitting start recording event from tray");
            if let Some(window) = app_clone.get_webview_window("main") {
                let _ = window.eval("sessionStorage.setItem('autoStartRecording', 'true')"); // Set the flag to start recording automatically
                let _ = window.eval("window.location.assign('/')");
            }
        }
    });
}

fn pause_recording_handler<R: Runtime>(app: &AppHandle<R>) {
    // Immediately show pausing state
    set_tray_state(app, RecordingState::Pausing);

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::audio::recording_commands::pause_recording(app_clone.clone()).await {
            log::error!("Failed to pause recording from tray: {}", e);
            // Revert to current state on error
            update_tray_menu_async(&app_clone).await;
        } else {
            log::info!("Recording paused from tray");
            // The pause_recording function will call update_tray_menu, so no need to call it here
        }
    });
}

fn resume_recording_handler<R: Runtime>(app: &AppHandle<R>) {
    // Immediately show resuming state
    set_tray_state(app, RecordingState::Resuming);

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = crate::audio::recording_commands::resume_recording(app_clone.clone()).await
        {
            log::error!("Failed to resume recording from tray: {}", e);
            // Revert to current state on error
            update_tray_menu_async(&app_clone).await;
        } else {
            log::info!("Recording resumed from tray");
            // The resume_recording function will call update_tray_menu, so no need to call it here
        }
    });
}

fn stop_recording_handler<R: Runtime>(app: &AppHandle<R>) {
    // Immediately show stopping state
    set_tray_state(app, RecordingState::Stopping);

    focus_main_window(app);
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        log::info!("Tray: Stopping recording...");

        // Generate save path (same as RecordingControls.tsx)
        let data_dir = match app_clone.path().app_data_dir() {
            Ok(dir) => dir,
            Err(e) => {
                log::error!("Failed to get app data dir: {}", e);
                update_tray_menu_async(&app_clone).await;
                return;
            }
        };

        let timestamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
        let save_path = data_dir.join(format!("recording-{}.wav", timestamp));

        // Call Rust stop_recording command (like pause/resume pattern)
        let stop_result = crate::audio::recording_commands::stop_recording(
            app_clone.clone(),
            crate::audio::recording_commands::RecordingArgs {
                save_path: save_path.to_string_lossy().to_string(),
            },
        )
        .await;

        // Handle result
        match stop_result {
            Ok(StopOutcome::Stopped) => {
                log::info!("Tray: Recording stopped successfully");

                // Trigger frontend post-processing via event (works from any page)
                // (SQLite save, navigation)
                if let Err(e) = app_clone.emit("recording-stop-complete", true) {
                    log::error!("Tray: Failed to emit recording-stop-complete event: {}", e);
                }
            }
            Ok(StopOutcome::AlreadyStopping) => {},
            Ok(StopOutcome::NotActive) => update_tray_menu_async(&app_clone).await,
            Err(e) => {
                log::error!("Tray: Failed to stop recording: {}", e);
                // Revert tray state on error
                update_tray_menu_async(&app_clone).await;
            }
        }
    });
}

fn check_updates_handler<R: Runtime>(app: &AppHandle<R>) {
    focus_main_window(app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(
            "window.dispatchEvent(new CustomEvent('check-updates-from-tray'))"
        );
    }
}

pub fn update_tray_menu<R: Runtime>(app: &AppHandle<R>) {
    // For sync update, spawn async task to get current state
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // Small delay to ensure recording state has been updated
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
        update_tray_menu_async(&app_clone).await;
    });
}

pub fn set_tray_state<R: Runtime>(app: &AppHandle<R>, state: RecordingState) {
    log::info!("Tray: Setting intermediate state: {:?}", state);
    // During recording state transitions, we assume recording is allowed (we're already recording)
    if let Ok(menu) = build_menu(app, state, true) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let result = tray.set_menu(Some(menu));
            log::info!("Tray: Intermediate state menu update result: {:?}", result);
        } else {
            log::warn!("Tray: Could not find tray with id 'main-tray'");
        }
    } else {
        log::error!("Tray: Failed to build menu for intermediate state");
    }
}

async fn get_current_recording_state() -> RecordingState {
    // Check if currently recording
    let is_recording = crate::audio::recording_commands::is_recording().await;
    log::info!(
        "Tray: get_current_recording_state - is_recording: {}",
        is_recording
    );

    if !is_recording {
        log::info!("Tray: Recording state is Stopped");
        return RecordingState::Stopped;
    }

    // Check if paused
    let is_paused = crate::audio::recording_commands::is_recording_paused().await;
    log::info!("Tray: is_paused: {}", is_paused);

    if is_paused {
        log::info!("Tray: Recording state is Paused");
        RecordingState::Paused
    } else {
        log::info!("Tray: Recording state is Recording");
        RecordingState::Recording
    }
}

/// Check if recording is allowed based on onboarding status and transcription model availability
/// Returns true if:
/// - Onboarding is complete (the user has their own transcription setup), OR
/// - Transcribe.CPP transcription model is ready (downloaded)
async fn check_can_record<R: Runtime>(app: &AppHandle<R>) -> bool {
    // First check if onboarding is complete
    let onboarding_complete = match crate::onboarding::load_onboarding_status(app).await {
        Ok(status) => status.completed,
        Err(e) => {
            log::warn!("Tray: Failed to load onboarding status: {}, assuming complete", e);
            true // Assume complete if we can't check (safe default)
        }
    };

    // If onboarding is complete, always allow recording
    // (the user went through model setup or chose to skip it)
    if onboarding_complete {
        return true;
    }

    // During onboarding, check if a Transcribe.CPP transcription model is ready
    match crate::transcribe_cpp_engine::commands::transcribecpp_has_transcription_model().await {
        Ok(has_models) => has_models,
        Err(e) => {
            log::warn!("Tray: Failed to check Transcribe.CPP models: {}, assuming not ready", e);
            false
        }
    }
}

pub async fn update_tray_menu_async<R: Runtime>(app: &AppHandle<R>) {
    log::info!("Tray: update_tray_menu_async called");
    // Get the current recording state
    let recording_state = get_current_recording_state().await;
    log::info!("Tray: Current recording state: {:?}", recording_state);

    // Determine if recording should be allowed
    // Only block recording during incomplete onboarding when no transcription model is ready
    let can_record = check_can_record(app).await;
    log::info!("Tray: can_record: {}", can_record);

    if let Ok(menu) = build_menu(app, recording_state, can_record) {
        if let Some(tray) = app.tray_by_id("main-tray") {
            let result = tray.set_menu(Some(menu));
            log::info!("Tray: Menu update result: {:?}", result);
        } else {
            log::warn!("Tray: Could not find tray with id 'main-tray'");
        }
    } else {
        log::error!("Tray: Failed to build menu");
    }
}

/// One planned menu entry, resolved independently of the tray toolkit: the
/// pure half of `build_menu` (labels per language, glyph per state, ids,
/// enabled flags), so the localization behavior is unit-testable headless
/// while `build_menu` stays a thin translation of specs into `MenuItem`s.
///
/// `label` includes the state glyph — the catalog values are emoji-free and
/// Rust prepends (spec D5). `id` is `None` for the disabled progress items,
/// which never had menu-event ids; keep it that way (`handle_menu_event`
/// dispatches on the ids that do exist).
#[derive(Debug, Clone, PartialEq, Eq)]
enum TrayItemSpec {
    Separator,
    Item {
        id: Option<&'static str>,
        label: String,
        enabled: bool,
    },
}

/// The state glyphs, one per state (spec D5). The exact code points the inline
/// literals used before localization: ⏳ U+23F3, 🔄 U+1F504, ⏸ U+23F8,
/// ⏹ U+23F9, ▶ U+25B6, each followed by one space.
const GLYPH_DOWNLOADING: &str = "⏳ ";
const GLYPH_STARTING: &str = "🔄 ";
const GLYPH_PAUSE: &str = "⏸ ";
const GLYPH_STOP: &str = "⏹ ";
const GLYPH_RESUME: &str = "▶ ";

/// Resolves the full menu for one language + recording state, once per call
/// (no caching — spec D4): the labels come from the `tray` catalog section of
/// `lang`, falling back to English per `TrayStrings::load`, and the glyph is
/// prepended here. The item ids and the separator layout mirror the original
/// pre-localization `build_menu` exactly.
fn tray_menu_items(
    lang: AppLanguage,
    state: RecordingState,
    can_record: bool,
) -> Vec<TrayItemSpec> {
    let strings = TrayStrings::load(lang);
    let item = |id: &'static str, label: String| TrayItemSpec::Item {
        id: Some(id),
        label,
        enabled: true,
    };
    let disabled = |label: String| TrayItemSpec::Item {
        id: None,
        label,
        enabled: false,
    };
    let stop = || {
        item(
            "stop_recording",
            format!("{GLYPH_STOP}{}", strings.stop_recording),
        )
    };

    let mut items = Vec::new();
    if !can_record {
        // Recording is not allowed (during onboarding, no transcription
        // model): a single disabled progress line replaces the state items.
        items.push(disabled(format!(
            "{GLYPH_DOWNLOADING}{}",
            strings.downloading_model
        )));
    } else {
        match state {
            RecordingState::Stopped => {
                items.push(item("toggle_recording", strings.start_recording));
            }
            RecordingState::Starting => {
                items.push(disabled(format!(
                    "{GLYPH_STARTING}{}",
                    strings.starting_recording
                )));
            }
            RecordingState::Recording => {
                items.push(item(
                    "pause_recording",
                    format!("{GLYPH_PAUSE}{}", strings.pause_recording),
                ));
                items.push(stop());
            }
            RecordingState::Pausing => {
                items.push(disabled(format!("{GLYPH_PAUSE}{}", strings.pausing)));
                items.push(stop());
            }
            RecordingState::Paused => {
                items.push(item(
                    "resume_recording",
                    format!("{GLYPH_RESUME}{}", strings.resume_recording),
                ));
                items.push(stop());
            }
            RecordingState::Resuming => {
                items.push(disabled(format!("{GLYPH_RESUME}{}", strings.resuming)));
                items.push(stop());
            }
            RecordingState::Stopping => {
                items.push(disabled(format!("{GLYPH_STOP}{}", strings.stopping)));
            }
        }
    }

    // Common tail, identical in every state.
    items.push(TrayItemSpec::Separator);
    items.push(item("open_window", strings.open_main_window));
    items.push(item("settings", strings.settings));
    items.push(item("check_updates", strings.check_for_updates));
    items.push(TrayItemSpec::Separator);
    items.push(item("quit", strings.quit));
    items
}

/// The language the tray renders in: the value ticket 02 keeps in shared app
/// state, read at call time (spec D4 — no cache). `init_app_language` manages
/// it before `create_tray`, so the fallback only guards a misordered startup.
fn current_language<R: Runtime>(app: &AppHandle<R>) -> AppLanguage {
    match app.try_state::<AppLanguageState>() {
        Some(state) => state.get(),
        None => {
            log::warn!("Tray: language state not managed yet, defaulting to English");
            AppLanguage::En
        }
    }
}

fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    state: RecordingState,
    can_record: bool, // True if recording is allowed (onboarding complete OR transcription model ready)
) -> tauri::Result<tauri::menu::Menu<R>> {
    let mut builder = MenuBuilder::new(app);

    for spec in tray_menu_items(current_language(app), state.clone(), can_record) {
        builder = match spec {
            TrayItemSpec::Separator => builder.item(&PredefinedMenuItem::separator(app)?),
            TrayItemSpec::Item { id, label, enabled } => {
                let mut item = match id {
                    Some(id) => MenuItemBuilder::with_id(id, label),
                    None => MenuItemBuilder::new(label),
                };
                if !enabled {
                    item = item.enabled(false);
                }
                builder.item(&item.build(app)?)
            }
        };
    }

    builder.build()
}

pub(crate) fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(e) = window.unminimize() {
            log::error!("Failed to unminimize main window: {}", e);
        }

        if let Err(e) = window.show() {
            log::error!("Failed to show main window: {}", e);
        }

        if let Err(e) = window.set_focus() {
            log::error!("Failed to focus main window: {}", e);
        }

        if let Err(e) = window.eval("window.focus()") {
            log::error!("Failed to focus main webview: {}", e);
        }
    } else {
        log::warn!("Could not find main window");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One menu entry reduced to what the headless test can observe:
    /// `Some((id, label, enabled))` for a normal item, `None` for a separator.
    fn entries(lang: AppLanguage, state: RecordingState, can_record: bool) -> Vec<(&'static str, String, bool)> {
        tray_menu_items(lang, state, can_record)
            .into_iter()
            .filter_map(|spec| match spec {
                TrayItemSpec::Separator => None,
                TrayItemSpec::Item { id, label, enabled } => Some((id.unwrap_or("«disabled»"), label, enabled)),
            })
            .collect()
    }

    /// The common tail every menu ends with, with the two separators removed:
    /// hand-derived from the ticket table (independent of the implementation).
    const TAIL: &[(&str, &str, bool)] = &[
        ("open_window", "Open Main Window", true),
        ("settings", "Settings", true),
        ("check_updates", "Check for Updates", true),
        ("quit", "Quit", true),
    ];

    fn assert_tail(items: &[(&'static str, String, bool)], tail: &[(&str, &str)]) {
        let tail_items = &items[items.len() - tail.len()..];
        for ((id, label, enabled), (expected_id, expected_label)) in tail_items.iter().zip(tail) {
            assert_eq!(id, expected_id);
            assert_eq!(label, expected_label);
            assert!(enabled, "tail item {expected_id} must be enabled");
        }
    }

    #[test]
    fn english_menu_labels_keep_the_pre_localization_literals_with_glyphs() {
        // Pins the migration: after the catalog move, every state renders the
        // exact label (glyph included) the inline literals produced before
        // (spec D5 moved the glyphs out of the catalog, not out of the menu).
        // Expected values are copied from the original `build_menu` literals,
        // not recomputed.
        let en = AppLanguage::En;
        assert_eq!(
            entries(en, RecordingState::Stopped, true),
            vec![("toggle_recording", "Start Recording".into(), true)]
                .into_iter()
                .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Starting, true),
            vec![("«disabled»", "🔄 Starting Recording...".into(), false)]
                .into_iter()
                .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Recording, true),
            vec![
                ("pause_recording", "⏸ Pause Recording".into(), true),
                ("stop_recording", "⏹ Stop Recording".into(), true),
            ]
            .into_iter()
            .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
            .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Pausing, true),
            vec![
                ("«disabled»", "⏸ Pausing...".into(), false),
                ("stop_recording", "⏹ Stop Recording".into(), true),
            ]
            .into_iter()
            .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Paused, true),
            vec![
                ("resume_recording", "▶ Resume Recording".into(), true),
                ("stop_recording", "⏹ Stop Recording".into(), true),
            ]
            .into_iter()
            .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Resuming, true),
            vec![
                ("«disabled»", "▶ Resuming...".into(), false),
                ("stop_recording", "⏹ Stop Recording".into(), true),
            ]
            .into_iter()
            .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            entries(en, RecordingState::Stopping, true),
            vec![("«disabled»", "⏹ Stopping...".into(), false)]
                .into_iter()
                .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
        // The 8th manual state: recording blocked while the model downloads.
        assert_eq!(
            entries(en, RecordingState::Stopped, false),
            vec![("«disabled»", "⏳ Downloading transcription model...".into(), false)]
                .into_iter()
                .chain(TAIL.iter().map(|(id, l, e)| (*id, (*l).into(), *e)))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn russian_menu_labels_use_the_ticket_wording_with_the_same_glyphs() {
        // Expected values hand-derived from the ticket 03 table and the spec
        // Vocabulary («Начать запись», «Пауза записи», …), independent of the
        // catalog file; the glyph is code (spec D5) and must match English.
        let ru = AppLanguage::Ru;
        let tail_ru = [
            ("open_window", "Открыть главное окно"),
            ("settings", "Настройки"),
            ("check_updates", "Проверить обновления"),
            ("quit", "Выйти"),
        ];

        let stopped = entries(ru, RecordingState::Stopped, true);
        assert_eq!(stopped[0], ("toggle_recording", "Начать запись".into(), true));
        assert_tail(&stopped, &tail_ru);

        let starting = entries(ru, RecordingState::Starting, true);
        assert_eq!(starting[0], ("«disabled»", "🔄 Запускается…".into(), false));
        assert_tail(&starting, &tail_ru);

        let recording = entries(ru, RecordingState::Recording, true);
        assert_eq!(
            recording[..2],
            [
                ("pause_recording", "⏸ Пауза записи".into(), true),
                ("stop_recording", "⏹ Остановить запись".into(), true),
            ]
        );
        assert_tail(&recording, &tail_ru);

        let pausing = entries(ru, RecordingState::Pausing, true);
        assert_eq!(
            pausing[0],
            ("«disabled»", "⏸ Постановка на паузу…".into(), false)
        );
        assert_eq!(pausing[1], ("stop_recording", "⏹ Остановить запись".into(), true));
        assert_tail(&pausing, &tail_ru);

        let paused = entries(ru, RecordingState::Paused, true);
        assert_eq!(paused[0], ("resume_recording", "▶ Продолжить запись".into(), true));
        assert_eq!(paused[1], ("stop_recording", "⏹ Остановить запись".into(), true));
        assert_tail(&paused, &tail_ru);

        let resuming = entries(ru, RecordingState::Resuming, true);
        assert_eq!(resuming[0], ("«disabled»", "▶ Возобновление…".into(), false));
        assert_eq!(resuming[1], ("stop_recording", "⏹ Остановить запись".into(), true));
        assert_tail(&resuming, &tail_ru);

        let stopping = entries(ru, RecordingState::Stopping, true);
        assert_eq!(stopping[0], ("«disabled»", "⏹ Остановка…".into(), false));
        assert_tail(&stopping, &tail_ru);

        let blocked = entries(ru, RecordingState::Stopped, false);
        assert_eq!(
            blocked[0],
            ("«disabled»", "⏳ Загрузка модели транскрибации…".into(), false)
        );
        assert_tail(&blocked, &tail_ru);
    }

    #[test]
    fn item_ids_survive_localization_in_every_state() {
        // The acceptance rule: `handle_menu_event` dispatches on these ids, so
        // the migration must not touch them, in either language. Disabled
        // items never had an id and must not gain one.
        for lang in [AppLanguage::En, AppLanguage::Ru] {
            let cases: &[(RecordingState, bool, &[&str])] = &[
                (RecordingState::Stopped, true, &["toggle_recording"]),
                (RecordingState::Starting, true, &[]),
                (RecordingState::Recording, true, &["pause_recording", "stop_recording"]),
                (RecordingState::Pausing, true, &["stop_recording"]),
                (RecordingState::Paused, true, &["resume_recording", "stop_recording"]),
                (RecordingState::Resuming, true, &["stop_recording"]),
                (RecordingState::Stopping, true, &[]),
                (RecordingState::Stopped, false, &[]),
            ];
            for (state, can_record, enabled_ids) in cases {
                let items = entries(lang, state.clone(), *can_record);
                let actual: Vec<&str> = items
                    .iter()
                    .filter(|(_, _, enabled)| *enabled)
                    .map(|(id, _, _)| *id)
                    .filter(|id| *id != "«disabled»")
                    .filter(|id| !matches!(*id, "open_window" | "settings" | "check_updates" | "quit"))
                    .collect();
                assert_eq!(
                    actual.as_slice(),
                    *enabled_ids,
                    "{lang:?} {state:?} can_record={can_record}: enabled action ids"
                );
                for (id, _, enabled) in &items {
                    if !enabled {
                        assert_eq!(id, &"«disabled»", "a disabled item must carry no id");
                    }
                }
            }
        }
    }

    #[test]
    fn menu_keeps_the_two_separator_groups_in_the_common_order() {
        // The tail layout: state items | separator | open/settings/updates |
        // separator | quit — the separators are structural, not labels.
        let specs = tray_menu_items(AppLanguage::En, RecordingState::Recording, true);
        let kinds: Vec<&str> = specs
            .iter()
            .map(|s| match s {
                TrayItemSpec::Separator => "---",
                TrayItemSpec::Item { id, .. } => id.unwrap_or("(no id)"),
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "pause_recording",
                "stop_recording",
                "---",
                "open_window",
                "settings",
                "check_updates",
                "---",
                "quit",
            ]
        );
    }

    #[test]
    fn build_menu_reads_the_managed_language_and_builds_headless() {
        // The thin tray seam: `build_menu` takes the language from managed
        // state (ticket 02) rather than a cache (spec D4), and menu building
        // itself works under the mock runtime. The menu item objects keep
        // their title set, which is what `MenuItem::title()` exposes.
        let app = tauri::test::mock_app();
        app.manage(AppLanguageState::new(AppLanguage::Ru));
        let menu = build_menu(app.handle(), RecordingState::Recording, true).expect("build ru menu");
        let items = menu.items().expect("menu items");
        let titles: Vec<String> = items
            .iter()
            .filter_map(|item| item.as_menuitem().map(|m| m.text().unwrap_or_default()))
            .collect();
        assert_eq!(
            titles,
            vec![
                "⏸ Пауза записи",
                "⏹ Остановить запись",
                "Открыть главное окно",
                "Настройки",
                "Проверить обновления",
                "Выйти",
            ]
        );

        // Switching the managed value and rebuilding re-localizes — the same
        // read-at-call-time behavior the language listener relies on.
        app.state::<AppLanguageState>().set(AppLanguage::En);
        let menu = build_menu(app.handle(), RecordingState::Recording, true).expect("build en menu");
        let titles: Vec<String> = menu
            .items()
            .expect("menu items")
            .iter()
            .filter_map(|item| {
                item.as_menuitem()
                    .map(|m: &tauri::menu::MenuItem<_>| m.text().unwrap_or_default())
            })
            .collect();
        assert_eq!(
            titles,
            vec![
                "⏸ Pause Recording",
                "⏹ Stop Recording",
                "Open Main Window",
                "Settings",
                "Check for Updates",
                "Quit",
            ]
        );
    }

    /// A mock app with the store plugin installed: `check_can_record` reads
    /// the onboarding store, and `app.store` panics without the plugin's
    /// managed `StoreState` (the real app installs it in `run()`).
    fn mock_app_with_store() -> tauri::App<tauri::test::MockRuntime> {
        tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app with the store plugin")
    }

    #[tokio::test]
    async fn update_tray_menu_async_builds_headless_without_a_tray() {
        // Exercises the live-switch path ticket 02's listener drives: no tray
        // was registered, so the update must log and return instead of
        // panicking — the menu is rebuilt from the managed language either way
        // (build_menu itself is covered above; here the whole read-state ->
        // build -> tray_by_id("main-tray") path must survive headless). The
        // store plugin backs `check_can_record`'s onboarding lookup; with no
        // onboarding store and no model manager it resolves can_record=false.
        let app = mock_app_with_store();
        app.manage(AppLanguageState::new(AppLanguage::Ru));
        update_tray_menu_async(app.handle()).await;
    }
}
