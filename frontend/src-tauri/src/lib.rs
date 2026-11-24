use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
// Removed unused import

// Performance optimization: Conditional logging macros for hot paths
#[cfg(debug_assertions)]
macro_rules! perf_debug {
    ($($arg:tt)*) => {
        log::debug!($($arg)*)
    };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_debug {
    ($($arg:tt)*) => {};
}

#[cfg(debug_assertions)]
macro_rules! perf_trace {
    ($($arg:tt)*) => {
        log::trace!($($arg)*)
    };
}

#[cfg(not(debug_assertions))]
macro_rules! perf_trace {
    ($($arg:tt)*) => {};
}

// Make these macros available to other modules
pub(crate) use perf_debug;
pub(crate) use perf_trace;

// Re-export async logging macros for external use (removed due to macro conflicts)

pub mod api;
pub mod audio;
pub mod audio_cpp_engine;
pub mod transcribe_cpp_engine;
pub mod config;
pub mod console_utils;
pub mod database;
pub mod doodle;
pub mod error_codes;
pub mod export;
pub mod notifications;
pub mod ollama;
pub mod onboarding;
pub mod openai;
pub mod anthropic;
pub mod groq;
pub mod l10n;
pub mod model_downloader;
pub mod openrouter;
pub mod state;
pub mod summary;
pub mod tray;
pub mod utils;

use audio::{list_audio_devices, AudioDevice, trigger_audio_permission};
use log::{error as log_error, info as log_info};
use notifications::commands::NotificationManagerState;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tokio::sync::RwLock;

type SplitLogger = (log::LevelFilter, Box<dyn log::Log>);

enum StartupLogDestination {
    Persistent(PathBuf),
    Stream,
}

fn startup_log_directory(app_data_dir: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        app_data_dir.join("logs-dev")
    }

    #[cfg(not(debug_assertions))]
    {
        app_data_dir.join("logs")
    }
}

fn acquire_startup_logger<T, E>(
    app_data_dir: Option<PathBuf>,
    mut acquire: impl FnMut(StartupLogDestination) -> Result<T, E>,
) -> Result<(T, bool), E> {
    if let Some(app_data_dir) = app_data_dir {
        if let Ok(logger) = acquire(StartupLogDestination::Persistent(
            startup_log_directory(&app_data_dir),
        )) {
            return Ok((logger, true));
        }
    }

    acquire(StartupLogDestination::Stream).map(|logger| (logger, false))
}

fn samobranka_log_builder(
    targets: Vec<tauri_plugin_log::Target>,
    verbose: bool,
) -> tauri_plugin_log::Builder {
    let builder = tauri_plugin_log::Builder::new()
        .targets(targets)
        .rotation_strategy({
            #[cfg(debug_assertions)]
            {
                tauri_plugin_log::RotationStrategy::KeepSome(10)
            }
            #[cfg(not(debug_assertions))]
            {
                tauri_plugin_log::RotationStrategy::KeepSome(5)
            }
        })
        .max_file_size(10_000_000)
        .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
        .format(|out, message, record| {
            let line = utils::bounded_log_line(format_args!(
                "[{}][{}][{}][{}:{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                record.file().unwrap_or("unknown"),
                record.line().unwrap_or(0),
                message
            ));
            out.finish(format_args!("{}", line))
        });

    if verbose {
        builder
            .level(log::LevelFilter::Info)
            .level_for("app_lib", log::LevelFilter::Debug)
    } else {
        builder
            .level(log::LevelFilter::Warn)
            .level_for("app_lib", log::LevelFilter::Info)
    }
}

fn split_startup_logger<R: Runtime>(
    app: &AppHandle<R>,
    app_data_dir: Option<PathBuf>,
    verbose: bool,
) -> Result<(SplitLogger, bool), tauri_plugin_log::Error> {
    acquire_startup_logger(app_data_dir, |destination| {
        let targets = match destination {
            StartupLogDestination::Persistent(path) => {
                #[cfg(debug_assertions)]
                {
                    vec![
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Folder {
                            path,
                            file_name: None,
                        }),
                    ]
                }
                #[cfg(not(debug_assertions))]
                {
                    vec![tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Folder {
                            path,
                            file_name: None,
                        },
                    )]
                }
            }
            StartupLogDestination::Stream => {
                #[cfg(debug_assertions)]
                {
                    vec![tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stdout,
                    )]
                }
                #[cfg(not(debug_assertions))]
                {
                    vec![tauri_plugin_log::Target::new(
                        tauri_plugin_log::TargetKind::Stderr,
                    )]
                }
            }
        };
        let (_, level, logger) = samobranka_log_builder(targets, verbose).split(app)?;
        Ok((level, logger))
    })
}
static RECORDING_FLAG: AtomicBool = AtomicBool::new(false);

// Global language preference storage (default to "auto" for automatic language detection)
static LANGUAGE_PREFERENCE: std::sync::LazyLock<StdMutex<String>> =
    std::sync::LazyLock::new(|| StdMutex::new("auto".to_string()));

#[derive(Debug, Deserialize)]
struct RecordingArgs {
    save_path: String,
}

#[derive(Debug, Serialize, Clone)]
struct TranscriptionStatus {
    chunks_in_queue: usize,
    is_processing: bool,
    last_activity_ms: u64,
}

#[tauri::command]
async fn start_recording<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    log_info!(
        "Recording start requested; microphone_configured={}, system_audio_configured={}, meeting_name_configured={}",
        mic_device_name.is_some(),
        system_device_name.is_some(),
        meeting_name.is_some()
    );

    if is_recording().await {
        return Err("Recording already in progress".to_string());
    }

    // Call the actual audio recording system with meeting name
    match audio::recording_commands::start_recording_with_devices_and_meeting(
        app.clone(),
        mic_device_name,
        system_device_name,
        meeting_name.clone(),
    )
    .await
    {
        Ok(_) => {
            RECORDING_FLAG.store(true, Ordering::SeqCst);
            tray::update_tray_menu(&app);

            log_info!("Recording started successfully");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording started notification");
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start audio recording: {}", e);
            Err(format!("Failed to start recording: {}", e))
        }
    }
}

#[tauri::command]
async fn stop_recording<R: Runtime>(app: AppHandle<R>, args: RecordingArgs) -> Result<audio::recording_commands::StopOutcome, String> {
    log_info!("Attempting to stop recording...");

    // Call the actual audio recording system to stop
    match audio::recording_commands::stop_recording(
        app.clone(),
        audio::recording_commands::RecordingArgs {
            save_path: args.save_path.clone(),
        },
    )
    .await
    {
        Ok(audio::recording_commands::StopOutcome::Stopped) => {
            RECORDING_FLAG.store(false, Ordering::SeqCst);
            tray::update_tray_menu(&app);

            // Create the save directory if it doesn't exist
            if let Some(parent) = std::path::Path::new(&args.save_path).parent() {
                if !parent.exists() {
                    log_info!("Creating directory: {:?}", parent);
                    if let Err(e) = std::fs::create_dir_all(parent) {
                        let err_msg = format!("Failed to create save directory: {}", e);
                        log_error!("{}", err_msg);
                        return Err(err_msg);
                    }
                }
            }

            // Show recording stopped notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_stopped_notification(
                &app,
                &notification_manager_state,
            )
            .await
            {
                log_error!(
                    "Failed to show recording stopped notification: {}",
                    e
                );
            } else {
                log_info!("Successfully showed recording stopped notification");
            }

            Ok(audio::recording_commands::StopOutcome::Stopped)
        }
        Ok(outcome) => Ok(outcome),
        Err(e) => {
            log_error!("Failed to stop audio recording: {}", e);
            // Still update the flag even if stopping failed
            RECORDING_FLAG.store(false, Ordering::SeqCst);
            tray::update_tray_menu(&app);
            Err(format!("Failed to stop recording: {}", e))
        }
    }
}

#[tauri::command]
async fn is_recording() -> bool {
    audio::recording_commands::is_recording().await
}

#[tauri::command]
fn get_transcription_status() -> TranscriptionStatus {
    TranscriptionStatus {
        chunks_in_queue: 0,
        is_processing: false,
        last_activity_ms: 0,
    }
}

#[tauri::command]
fn read_audio_file(file_path: String) -> Result<Vec<u8>, String> {
    match std::fs::read(&file_path) {
        Ok(data) => Ok(data),
        Err(e) => Err(format!("Failed to read audio file: {}", e)),
    }
}

#[tauri::command]
async fn save_transcript(file_path: String, content: String) -> Result<(), String> {
    log_info!("Saving transcript");

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&file_path).parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    // Write content to file
    std::fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write transcript: {}", e))?;

    log_info!("Transcript saved successfully");
    Ok(())
}

// Audio level monitoring commands
#[tauri::command]
async fn start_audio_level_monitoring<R: Runtime>(
    app: AppHandle<R>,
    device_names: Vec<String>,
) -> Result<(), String> {
    log_info!(
        "Starting audio level monitoring for devices: {:?}",
        device_names
    );

    audio::simple_level_monitor::start_monitoring(app, device_names)
        .await
        .map_err(|e| format!("Failed to start audio level monitoring: {}", e))
}

#[tauri::command]
async fn stop_audio_level_monitoring() -> Result<(), String> {
    log_info!("Stopping audio level monitoring");

    audio::simple_level_monitor::stop_monitoring()
        .await
        .map_err(|e| format!("Failed to stop audio level monitoring: {}", e))
}

#[tauri::command]
async fn is_audio_level_monitoring() -> bool {
    audio::simple_level_monitor::is_monitoring()
}

/// Open the shared app-data models directory (all engine model files live
/// under `<app_data_dir>/models`). The settings screen offers this for the
/// user to inspect downloaded models without the app holding them open.
#[tauri::command]
async fn open_models_folder<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let models_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?
        .join("models");
    if !models_dir.exists() {
        std::fs::create_dir_all(&models_dir)
            .map_err(|e| format!("Failed to create directory: {e}"))?;
    }
    let folder_path = models_dir.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&folder_path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn get_audio_devices() -> Result<Vec<AudioDevice>, String> {
    list_audio_devices()
        .await
        .map_err(|e| format!("Failed to list audio devices: {}", e))
}

#[tauri::command]
async fn trigger_microphone_permission() -> Result<bool, String> {
    trigger_audio_permission()
        .map_err(|e| format!("Failed to trigger microphone permission: {}", e))
}

#[tauri::command]
async fn start_recording_with_devices<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
) -> Result<(), String> {
    start_recording_with_devices_and_meeting(app, mic_device_name, system_device_name, None).await
}

#[tauri::command]
async fn start_recording_with_devices_and_meeting<R: Runtime>(
    app: AppHandle<R>,
    mic_device_name: Option<String>,
    system_device_name: Option<String>,
    meeting_name: Option<String>,
) -> Result<(), String> {
    log_info!(
        "Recording start requested; microphone_configured={}, system_audio_configured={}, meeting_name_configured={}",
        mic_device_name.is_some(),
        system_device_name.is_some(),
        meeting_name.is_some()
    );
    let meeting_name_for_notification = meeting_name.clone();
    let recording_result = if mic_device_name.is_none() && system_device_name.is_none() {
        audio::recording_commands::start_recording_with_meeting_name(app.clone(), meeting_name)
            .await
    } else {
        audio::recording_commands::start_recording_with_devices_and_meeting(
            app.clone(),
            mic_device_name,
            system_device_name,
            meeting_name,
        )
        .await
    };

    match recording_result {
        Ok(_) => {
            log_info!("Recording started successfully via tauri command");

            // Show recording started notification through NotificationManager
            // This respects user's notification preferences
            let notification_manager_state = app.state::<NotificationManagerState<R>>();
            if let Err(e) = notifications::commands::show_recording_started_notification(
                &app,
                &notification_manager_state,
                meeting_name_for_notification.clone(),
            )
            .await
            {
                log_error!(
                    "Failed to show recording started notification: {}",
                    e
                );
            }

            Ok(())
        }
        Err(e) => {
            log_error!("Failed to start recording via tauri command: {}", e);
            Err(e)
        }
    }
}

#[tauri::command]
async fn set_language_preference(language: String) -> Result<(), String> {
    let mut lang_pref = LANGUAGE_PREFERENCE
        .lock()
        .map_err(|e| format!("Failed to set language preference: {}", e))?;
    log_info!("Setting language preference to: {}", language);
    *lang_pref = language;
    Ok(())
}

// Internal helper function to get language preference (for use within Rust code)
pub fn get_language_preference_internal() -> Option<String> {
    LANGUAGE_PREFERENCE.lock().ok().map(|lang| lang.clone())
}

pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            log_info!(
                "Second app instance requested; argument_count={}, cwd_present={}",
                args.len(),
                !cwd.is_empty()
            );

            tray::focus_main_window(app);
        }));
    }

    builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_log::Builder::new().skip_logger().build())
        .plugin(tauri_plugin_dialog::init())
        // Updater re-enabled: own GitHub endpoint + new minisign key pair (see ADR 0002 follow-up).
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(RwLock::new(
            None::<notifications::manager::NotificationManager<tauri::Wry>>,
        )) as NotificationManagerState<tauri::Wry>)
        .manage(audio::init_system_audio_state())
        .manage(summary::summary_engine::ModelManagerState(Arc::new(tokio::sync::Mutex::new(None))))
        .setup(|_app| {
            let verbose = cfg!(debug_assertions)
                || std::env::var("SAMOBRANKA_DEBUG_LOG")
                    .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
                    .unwrap_or(false);
            let app_data_dir = _app.path().app_data_dir().ok();
            match split_startup_logger(_app.handle(), app_data_dir, verbose) {
                Ok(((level, logger), persistent)) => {
                    if tauri_plugin_log::attach_logger(level, logger).is_err() || !persistent {
                        eprintln!("Samobranka logging is unavailable or degraded.");
                    }
                }
                Err(_) => eprintln!("Samobranka logging is unavailable or degraded."),
            }

            log::info!("Starting application...");
            log::info!("Application setup complete");

            // Resolve the interface language before the tray exists (native-i18n
            // spec D3/D4): reads `app_language` from preferences.json, falls
            // back to the OS locale, keeps the value in managed state, and
            // registers the `app-language-changed` listener. Must precede
            // `create_tray` so ticket 03's menu build can read the state.
            l10n::language::init_app_language(_app.handle());

            // Initialize system tray
            if let Err(e) = tray::create_tray(_app.handle()) {
                log::error!("Failed to create system tray: {}", e);
            }

            // Initialize notification system with proper defaults
            log::info!("Initializing notification system...");
            let app_for_notif = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let notif_state = app_for_notif.state::<NotificationManagerState<tauri::Wry>>();
                match notifications::commands::initialize_notification_manager(app_for_notif.clone()).await {
                    Ok(manager) => {
                        // Set default consent and permissions on first launch
                        if let Err(e) = manager.set_consent(true).await {
                            log::error!("Failed to set initial consent: {}", e);
                        }
                        if let Err(e) = manager.request_permission().await {
                            log::error!("Failed to request initial permission: {}", e);
                        }

                        // Store the initialized manager
                        let mut state_lock = notif_state.write().await;
                        *state_lock = Some(manager);
                        log::info!("Notification system initialized with default permissions");
                    }
                    Err(e) => {
                        log::error!("Failed to initialize notification manager: {}", e);
                    }
                }
            });

            // Set audio.cpp models directory (shared app-data models root) and
            // initialize the model manager. Model management does not need the
            // native library, so this must not depend on `libaudiocpp`.
            audio_cpp_engine::commands::set_models_directory(&_app.handle());
            tauri::async_runtime::spawn(async {
                if let Err(e) = audio_cpp_engine::commands::audiocpp_model_init().await {
                    log::error!("Failed to initialize audio.cpp model manager on startup: {}", e);
                }
            });

            // Set transcribe.cpp models directory (shared app-data models root)
            // and initialize the model manager. Model management does not need
            // the native library, so this must not depend on `libtranscribe`.
            transcribe_cpp_engine::commands::set_models_directory(&_app.handle());
            tauri::async_runtime::spawn(async {
                if let Err(e) = transcribe_cpp_engine::commands::transcribecpp_model_init().await {
                    log::error!(
                        "Failed to initialize transcribe.cpp model manager on startup: {}",
                        e
                    );
                }
            });

            // Initialize ModelManager for summary engine (async, non-blocking)
            let app_handle_for_model_manager = _app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match summary::summary_engine::commands::init_model_manager_at_startup(&app_handle_for_model_manager).await {
                    Ok(_) => log::info!("ModelManager initialized successfully at startup"),
                    Err(e) => {
                        log::warn!("Failed to initialize ModelManager at startup: {}", e);
                        log::warn!("ModelManager will be lazy-initialized on first use");
                    }
                }
            });

            // Trigger system audio permission request on startup (similar to microphone permission)
            // #[cfg(target_os = "macos")]
            // {
            //     tauri::async_runtime::spawn(async {
            //         if let Err(e) = audio::permissions::trigger_system_audio_permission() {
            //             log::warn!("Failed to trigger system audio permission: {}", e);
            //         }
            //     });
            // }

            // Initialize database (handles first launch detection and conditional setup)
            tauri::async_runtime::block_on(async {
                database::setup::initialize_database_on_startup(&_app.handle()).await
            })
            .expect("Failed to initialize database");

            // Give meetings created before the meeting date and duration
            // existed their values. Detached on purpose: reading recording
            // folders can be slow, and startup must not wait for it. On first
            // launch there is no database yet, so there is nothing to backfill.
            if let Some(state) = _app.try_state::<state::AppState>() {
                database::backfill::spawn_backfill_at_startup(state.db_manager.pool().clone());
            }

            // Initialize bundled templates directory for dynamic template discovery
            log::info!("Initializing bundled templates directory...");
            if let Ok(resource_path) = _app.handle().path().resource_dir() {
                let templates_dir = resource_path.join("templates");
                log::info!("Setting bundled templates directory to: {:?}", templates_dir);
                summary::templates::set_bundled_templates_dir(templates_dir);
            } else {
                log::warn!("Failed to resolve resource directory for templates");
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(e) = window.hide() {
                        log::error!("Failed to hide main window on close request: {}", e);
                    } else {
                        log::info!("Main window hidden to tray on close request");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            is_recording,
            get_transcription_status,
            read_audio_file,
            save_transcript,
            doodle::doodle_sync,
            // audio.cpp engine commands (FFI layer)
            audio_cpp_engine::commands::audiocpp_diagnostics,
            // transcribe.cpp engine diagnostics (FFI layer)
            transcribe_cpp_engine::diagnostics::transcribecpp_diagnostics,
            // audio.cpp model management
            audio_cpp_engine::commands::audiocpp_model_init,
            audio_cpp_engine::commands::audiocpp_get_available_models,
            audio_cpp_engine::commands::audiocpp_has_available_models,
            audio_cpp_engine::commands::audiocpp_get_models_directory,
            audio_cpp_engine::commands::audiocpp_download_model,
            audio_cpp_engine::commands::audiocpp_cancel_download,
            audio_cpp_engine::commands::audiocpp_delete_model,
            audio_cpp_engine::commands::open_audiocpp_models_folder,
            transcribe_cpp_engine::commands::transcribecpp_model_init,
            transcribe_cpp_engine::commands::transcribecpp_get_available_models,
            transcribe_cpp_engine::commands::transcribecpp_has_available_models,
            transcribe_cpp_engine::commands::transcribecpp_has_transcription_model,
            transcribe_cpp_engine::commands::transcribecpp_get_models_directory,
            transcribe_cpp_engine::commands::transcribecpp_download_model,
            transcribe_cpp_engine::commands::transcribecpp_cancel_download,
            transcribe_cpp_engine::commands::transcribecpp_delete_model,
            transcribe_cpp_engine::commands::open_transcribecpp_models_folder,
            get_audio_devices,
            trigger_microphone_permission,
            start_recording_with_devices,
            start_recording_with_devices_and_meeting,
            start_audio_level_monitoring,
            stop_audio_level_monitoring,
            is_audio_level_monitoring,
            // Recording pause/resume commands
            audio::recording_commands::pause_recording,
            audio::recording_commands::resume_recording,
            audio::recording_commands::is_recording_paused,
            audio::recording_commands::get_recording_state,
            audio::recording_commands::get_meeting_folder_path,
            // Reload sync commands (retrieve transcript history and meeting name)
            audio::recording_commands::get_transcript_history,
            audio::recording_commands::get_recording_meeting_name,
            // Playback device detection (Bluetooth warning)
            audio::recording_commands::get_active_audio_output,
            // Audio recovery commands (for transcript recovery feature)
            audio::incremental_saver::recover_audio_from_checkpoints,
            audio::incremental_saver::cleanup_checkpoints,
            audio::incremental_saver::has_audio_checkpoints,
            console_utils::show_console,
            console_utils::hide_console,
            console_utils::toggle_console,
            ollama::get_ollama_models,
            ollama::pull_ollama_model,
            ollama::delete_ollama_model,
            ollama::get_ollama_model_context,
            openai::openai::get_openai_models,
            anthropic::anthropic::get_anthropic_models,
            groq::groq::get_groq_models,
            api::api_get_meetings,
            api::api_search_transcripts,
            api::api_get_profile,
            api::api_save_profile,
            api::api_update_profile,
            api::api_get_model_config,
            api::api_save_model_config,
            api::api_get_summary_system_prompt,
            api::api_save_summary_system_prompt,
            api::api_get_api_key,
            // api::api_get_auto_generate_setting,
            // api::api_save_auto_generate_setting,
            api::api_get_transcript_config,
            api::api_save_transcript_config,
            api::api_get_transcript_api_key,
            api::api_delete_meeting,
            api::api_get_meeting,
            api::api_get_meeting_metadata,
            api::api_get_meeting_transcripts,
            api::api_get_meeting_speakers,
            api::api_assign_meeting_speakers,
            api::api_set_transcript_speaker,
            api::api_update_transcript_text,
            api::api_delete_transcripts,
            api::api_get_speaker_names,
            api::api_save_meeting_title,
            api::api_save_transcript,
            audio::diarization_commands::audiocpp_diarize_meeting,
            api::open_meeting_folder,
            api::test_backend_connection,
            api::debug_backend_connection,
            api::open_external_url,
            // Custom OpenAI commands
            api::api_save_custom_openai_config,
            api::api_get_custom_openai_config,
            api::api_test_custom_openai_connection,
            // Summary commands
            summary::commands::api_process_transcript,
            summary::commands::api_get_summary,
            summary::commands::api_save_meeting_summary,
            summary::commands::api_get_meeting_summary_language,
            summary::commands::api_save_meeting_summary_language,
            summary::commands::api_get_meeting_detected_summary_language,
            summary::commands::api_save_meeting_detected_summary_language,
            summary::commands::api_detect_transcript_summary_language,
            summary::commands::api_cancel_summary,
            // Template commands
            summary::template_commands::api_list_templates,
            summary::template_commands::api_get_template_details,
            summary::template_commands::api_validate_template,
            // Built-in AI commands
            summary::summary_engine::commands::builtin_ai_list_models,
            summary::summary_engine::commands::builtin_ai_get_model_info,
            summary::summary_engine::commands::builtin_ai_download_model,
            summary::summary_engine::commands::builtin_ai_cancel_download,
            summary::summary_engine::commands::builtin_ai_delete_model,
            summary::summary_engine::commands::builtin_ai_is_model_ready,
            summary::summary_engine::commands::builtin_ai_get_available_summary_model,
            summary::summary_engine::commands::builtin_ai_get_recommended_model,
            openrouter::get_openrouter_models,
            audio::recording_preferences::get_recording_preferences,
            audio::recording_preferences::set_recording_preferences,
            audio::recording_preferences::get_default_recordings_folder_path,
            audio::recording_preferences::open_recordings_folder,
            audio::recording_preferences::select_recording_folder,
            audio::recording_preferences::get_available_audio_backends,
            audio::recording_preferences::get_current_audio_backend,
            audio::recording_preferences::set_audio_backend,
            audio::recording_preferences::get_audio_backend_info,
            // Language preference commands
            set_language_preference,
            // Notification system commands
            notifications::commands::get_notification_settings,
            notifications::commands::set_notification_settings,
            notifications::commands::request_notification_permission,
            notifications::commands::show_notification,
            notifications::commands::show_test_notification,
            notifications::commands::is_dnd_active,
            notifications::commands::get_system_dnd_status,
            notifications::commands::set_manual_dnd,
            notifications::commands::set_notification_consent,
            notifications::commands::clear_notifications,
            notifications::commands::is_notification_system_ready,
            notifications::commands::initialize_notification_manager_manual,
            notifications::commands::test_notification_with_auto_consent,
            notifications::commands::get_notification_stats,
            // System audio capture commands
            audio::system_audio_commands::start_system_audio_capture_command,
            audio::system_audio_commands::list_system_audio_devices_command,
            audio::system_audio_commands::check_system_audio_permissions_command,
            audio::system_audio_commands::start_system_audio_monitoring,
            audio::system_audio_commands::stop_system_audio_monitoring,
            audio::system_audio_commands::get_system_audio_monitoring_status,
            // Screen Recording permission commands
            audio::permissions::check_screen_recording_permission_command,
            audio::permissions::request_screen_recording_permission_command,
            audio::permissions::trigger_system_audio_permission_command,
            // Database import commands
            database::commands::check_first_launch,
            database::commands::select_legacy_database_path,
            database::commands::detect_legacy_database,
            database::commands::check_default_legacy_database,
            database::commands::check_homebrew_database,
            database::commands::import_and_initialize_database,
            database::commands::initialize_fresh_database,
            // Database and Models path commands
            database::commands::get_database_directory,
            database::commands::open_database_folder,
            open_models_folder,
            // Onboarding commands
            onboarding::get_onboarding_status,
            onboarding::save_onboarding_status_cmd,
            onboarding::reset_onboarding_status_cmd,
            onboarding::complete_onboarding,
            // System settings commands
            #[cfg(target_os = "macos")]
            utils::open_system_settings,
            // Retranscription commands
            audio::retranscription::start_retranscription_command,
            audio::retranscription::cancel_retranscription_command,
            audio::retranscription::is_retranscription_in_progress_command,
            // Import audio commands
            audio::import::select_and_validate_audio_command,
            audio::import::validate_audio_file_command,
            audio::import::start_import_audio_command,
            audio::import::cancel_import_command,
            audio::import::is_import_in_progress_command,
            // Transcript export command
            export::export_transcript_file_command,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, event| {
            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    tray::focus_main_window(_app_handle);
                }
                tauri::RunEvent::Exit => {
                    log::info!("Application exiting, cleaning up resources...");
                    tauri::async_runtime::block_on(async {
                        // Clean up database connection and checkpoint WAL
                        if let Some(app_state) = _app_handle.try_state::<state::AppState>() {
                            log::info!("Starting database cleanup...");
                            if let Err(e) = app_state.db_manager.cleanup().await {
                                log::error!("Failed to cleanup database: {}", e);
                            } else {
                                log::info!("Database cleanup completed successfully");
                            }
                        } else {
                            log::warn!("AppState not available for database cleanup (likely first launch)");
                        }

                        // Clean up sidecar
                        log::info!("Cleaning up sidecar...");
                        if let Err(e) = summary::summary_engine::force_shutdown_sidecar().await {
                            log::error!("Failed to force shutdown sidecar: {}", e);
                        }
                    });
                    log::info!("Application cleanup complete");
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{acquire_startup_logger, startup_log_directory, StartupLogDestination};
    use std::cell::RefCell;

    #[test]
    fn logging_startup_falls_back_when_log_path_is_a_file() {
        let temp_dir = tempfile::tempdir().unwrap();
        let app_data_dir = temp_dir.path().join("app-data");
        std::fs::write(&app_data_dir, "").unwrap();
        let attempts = RefCell::new(Vec::new());

        let logger = acquire_startup_logger(Some(app_data_dir), |destination| match destination {
            StartupLogDestination::Persistent(path) => {
                attempts.borrow_mut().push("persistent");
                std::fs::create_dir_all(path).map(|_| "persistent")
            }
            StartupLogDestination::Stream => {
                attempts.borrow_mut().push("stream");
                Ok("stream")
            }
        })
        .unwrap();

        assert_eq!(logger, ("stream", false));
        assert_eq!(*attempts.borrow(), ["persistent", "stream"]);
    }

    #[test]
    fn logging_startup_uses_persistent_sink_when_writable() {
        let temp_dir = tempfile::tempdir().unwrap();
        let app_data_dir = temp_dir.path().join("app-data");
        let expected_log_dir = startup_log_directory(&app_data_dir);

        let logger = acquire_startup_logger(Some(app_data_dir), |destination| match destination {
            StartupLogDestination::Persistent(path) => {
                std::fs::create_dir_all(&path)?;
                Ok::<_, std::io::Error>(path)
            }
            StartupLogDestination::Stream => unreachable!("stream fallback was not needed"),
        })
        .unwrap();

        assert!(logger.1);
        assert_eq!(logger.0, expected_log_dir);
        assert!(logger.0.is_dir());
    }

    #[test]
    fn logging_startup_handles_missing_data_dir() {
        let logger = acquire_startup_logger(None, |destination| match destination {
            StartupLogDestination::Persistent(_) => unreachable!("no persistent path was provided"),
            StartupLogDestination::Stream => Ok::<_, std::io::Error>("stream"),
        })
        .unwrap();

        assert_eq!(logger, ("stream", false));
    }
}
