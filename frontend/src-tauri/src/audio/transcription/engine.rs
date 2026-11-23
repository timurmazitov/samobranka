// audio/transcription/engine.rs
//
// TranscriptionEngine enum and model initialization/validation logic.

use super::provider::TranscriptionProvider;
use crate::error_codes::{
    error_params, CodedError, TRANSCRIPTION_MODEL_DISCOVERY_FAILED,
    TRANSCRIPTION_MODEL_LOAD_FAILED, TRANSCRIPTION_MODEL_MANAGER_UNINITIALIZED,
};
use log::{info, warn};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};

// ============================================================================
// TRANSCRIPTION ENGINE ENUM
// ============================================================================

// Transcription engine abstraction to support multiple providers
pub enum TranscriptionEngine {
    Provider(Arc<dyn TranscriptionProvider>), // Trait-based (the only local engine this build ships)
}

/// Provider id for the audio.cpp engine (GLOSSARY: «провайдер транскрибации»).
///
/// The engine itself no longer transcribes (it only diarizes); the id stays
/// so the settings soft migration can still recognize legacy saved configs
/// that name it.
pub const AUDIO_CPP_PROVIDER: &str = "audioCpp";

/// Provider id for the transcribe.cpp engine (GLOSSARY: «провайдер транскрибации»).
pub const TRANSCRIBE_CPP_PROVIDER: &str = "transcribeCpp";

impl TranscriptionEngine {
    /// Check if the engine has a model loaded
    pub async fn is_model_loaded(&self) -> bool {
        match self {
            Self::Provider(provider) => provider.is_model_loaded().await,
        }
    }

    /// Get the current model name
    pub async fn get_current_model(&self) -> Option<String> {
        match self {
            Self::Provider(provider) => provider.get_current_model().await,
        }
    }

    /// Get the provider name for logging
    pub fn provider_name(&self) -> &str {
        match self {
            Self::Provider(provider) => provider.provider_name(),
        }
    }
}

// ============================================================================
// MODEL VALIDATION AND INITIALIZATION
// ============================================================================

/// Validate that a transcription model is ready before starting recording
///
/// The `Err` carries the stable error code of the failing stage (native-i18n
/// spec D7) beside the English prose so the recording-start emitters can add
/// `code`/`params` to the `transcription-error` payload without re-parsing
/// text; callers that need the old `String` use `.message`.
pub async fn validate_transcription_model_ready<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), crate::error_codes::CodedError> {
    // Check transcript configuration to determine which engine to validate
    let config =
        match crate::api::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
            .await
        {
            Ok(Some(config)) => {
                info!(
                    "📝 Found transcript config - provider: {}, model: {}",
                    config.provider, config.model
                );
                config
            }
            Ok(None) => {
                info!("📝 No transcript config found, defaulting to transcribe.cpp");
                crate::api::api::TranscriptConfig {
                    provider: TRANSCRIBE_CPP_PROVIDER.to_string(),
                    model: crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string(),
                    api_key: None,
                    transcribe_backend: None,
                }
            }
            Err(e) => {
                warn!(
                    "⚠️ Failed to get transcript config: {}, defaulting to transcribe.cpp",
                    e
                );
                crate::api::api::TranscriptConfig {
                    provider: TRANSCRIBE_CPP_PROVIDER.to_string(),
                    model: crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string(),
                    api_key: None,
                    transcribe_backend: None,
                }
            }
        };

    // Validate based on provider
    match config.provider.as_str() {
        TRANSCRIBE_CPP_PROVIDER => {
            info!("🔍 Validating transcribeCpp model...");
            match get_or_init_transcribe_cpp_provider(app).await {
                Ok(provider) => {
                    let model = provider
                        .get_current_model()
                        .await
                        .unwrap_or_else(|| "unknown".to_string());
                    info!(
                        "✅ transcribeCpp model validation successful: {} is ready",
                        model
                    );
                    Ok(())
                }
                Err(e) => {
                    warn!("❌ transcribeCpp model validation failed: {}", e);
                    Err(e)
                }
            }
        }
        other => {
            // Spec: the default for an unknown provider is TranscribeCpp.
            // Anything unrecognized here (a leftover from a removed engine,
            // or any other value) validates as the transcribe.cpp default,
            // so recording never dead-ends on a stale saved value. The
            // transcript-config read in the settings repository only maps
            // the removed provider ids, so this engine-level fallback is
            // deliberately broader.
            warn!(
                "🔍 Unrecognized transcription provider '{}' in the transcript config; validating transcribeCpp instead",
                other
            );
            match get_or_init_transcribe_cpp_provider(app).await {
                Ok(provider) => {
                    let model = provider
                        .get_current_model()
                        .await
                        .unwrap_or_else(|| "unknown".to_string());
                    info!(
                        "✅ transcribeCpp model validation successful: {} is ready",
                        model
                    );
                    Ok(())
                }
                Err(e) => {
                    warn!("❌ transcribeCpp model validation failed: {}", e);
                    Err(e)
                }
            }
        }
    }
}

/// Get or initialize the appropriate transcription engine based on provider configuration
///
/// Failures carry the stable code of the failing stage beside the prose
/// (native-i18n spec D7) — see [`crate::error_codes`].
pub async fn get_or_init_transcription_engine<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<TranscriptionEngine, CodedError> {
    // Get provider configuration from API
    let config =
        match crate::api::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
            .await
        {
            Ok(Some(config)) => {
                info!(
                    "📝 Transcript config - provider: {}, model: {}",
                    config.provider, config.model
                );
                config
            }
            Ok(None) => {
                info!("📝 No transcript config found, defaulting to transcribe.cpp");
                crate::api::api::TranscriptConfig {
                    provider: TRANSCRIBE_CPP_PROVIDER.to_string(),
                    model: crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string(),
                    api_key: None,
                    transcribe_backend: None,
                }
            }
            Err(e) => {
                warn!(
                    "⚠️ Failed to get transcript config: {}, defaulting to transcribe.cpp",
                    e
                );
                crate::api::api::TranscriptConfig {
                    provider: TRANSCRIBE_CPP_PROVIDER.to_string(),
                    model: crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string(),
                    api_key: None,
                    transcribe_backend: None,
                }
            }
        };

    // Initialize the appropriate engine based on provider
    match config.provider.as_str() {
        TRANSCRIBE_CPP_PROVIDER => {
            info!("🧠 Initializing transcribeCpp transcription engine");
            let provider = get_or_init_transcribe_cpp_provider(app).await?;
            Ok(TranscriptionEngine::Provider(provider))
        }
        _ => {
            // Spec: the default for an unknown provider is TranscribeCpp, so
            // any provider this build does not run locally (a leftover from a
            // removed engine or an unrecognized value) initializes
            // transcribe.cpp. This engine-level fallback is deliberately
            // broader than normalize_transcript_provider in the settings
            // repository, which only maps the removed provider ids and
            // leaves other unknown values untouched.
            info!(
                "🧠 Initializing transcribeCpp transcription engine (provider '{}' is not a local engine of this build)",
                config.provider
            );
            let provider = get_or_init_transcribe_cpp_provider(app).await?;
            Ok(TranscriptionEngine::Provider(provider))
        }
    }
}


/// Get or initialize the transcribeCpp transcription provider from the
/// configured model.
///
/// The provider is cached process-wide, so a second recording reuses the
/// already-loaded model. Failures are returned as user-facing messages: a
/// missing, downloading or corrupted model never reaches the native session
/// setup, and a native load/session error is reported instead of panicking.
pub async fn get_or_init_transcribe_cpp_provider<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<Arc<dyn TranscriptionProvider>, CodedError> {
    get_or_init_transcribe_cpp_provider_with_model(app, None).await
}

/// Get or initialize the transcribeCpp provider, optionally for a specific
/// model.
///
/// Batch jobs (retranscription, audio import) let the user pick any installed
/// transcribe.cpp model in the dialog, which may differ from the configured
/// one. When `requested_model` is `Some`, that exact model is loaded — with
/// no fallback to another installed model, since silently transcribing with a
/// different model would defeat the comparison the user is making — and a
/// cached provider is reused only when it already runs that model.
///
/// The compute mode (GLOSSARY: «режим вычислений», the saved
/// `transcribeBackend` column) travels to the native load; a cached provider
/// is reloaded when the saved mode changed, exactly like a model change.
pub async fn get_or_init_transcribe_cpp_provider_with_model<R: Runtime>(
    app: &AppHandle<R>,
    requested_model: Option<String>,
) -> Result<Arc<dyn TranscriptionProvider>, CodedError> {
    use tauri::Emitter;

    let mode = saved_transcribe_cpp_compute_mode(app).await;

    if let Some((provider, cached_mode)) =
        crate::transcribe_cpp_engine::transcription::provider_with_mode()
    {
        if provider.is_model_loaded().await {
            let current = provider
                .get_current_model()
                .await
                .unwrap_or_else(|| "unknown".to_string());
            if crate::transcribe_cpp_engine::transcription::provider_is_reusable(
                &current,
                requested_model.as_deref(),
                cached_mode,
                mode,
            ) {
                info!(
                    "✅ transcribeCpp model '{}' already loaded on mode '{}', reusing",
                    current,
                    mode.as_str()
                );
                return Ok(provider);
            }
            info!(
                "🔄 Loaded transcribeCpp model '{}' / mode '{}' does not match requested '{}' / '{}', reloading",
                current,
                cached_mode.as_str(),
                requested_model.as_deref().unwrap_or(""),
                mode.as_str()
            );
        }
    }

    // The transcript config supplies the model only when no explicit model
    // was requested; a batch job with an explicit model must not depend on
    // (or validate against) the configured provider. An empty configured
    // model (or no config row at all) uses the catalog default, mirroring
    // the api_get_transcript_config fallback so both agree on one model.
    let configured_model = match requested_model {
        Some(_) => String::new(),
        None => match crate::api::api::api_get_transcript_config(
            app.clone(),
            app.clone().state(),
            None,
        )
        .await
        {
            Ok(Some(config)) if config.provider == TRANSCRIBE_CPP_PROVIDER => {
                if config.model.is_empty() {
                    crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string()
                } else {
                    config.model
                }
            }
            Ok(Some(config)) => {
                // Internal bug (provider mismatch), not a user-fixable state:
                // no code, the frontend shows the prose.
                return Err(CodedError::plain(format!(
                    "Cannot initialize transcribeCpp: the transcript provider is '{}'. This is a bug in the transcription task initialization.",
                    config.provider
                )));
            }
            Ok(None) => crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string(),
            Err(e) => {
                warn!("⚠️ Failed to get transcript config for transcribeCpp: {}", e);
                crate::config::DEFAULT_TRANSCRIBE_CPP_MODEL.to_string()
            }
        },
    };

    let manager = crate::transcribe_cpp_engine::commands::model_manager()
        .ok_or_else(|| {
            CodedError::coded(
                "The transcribe.cpp model manager is not initialized. Restart Samobranka and try again.",
                TRANSCRIPTION_MODEL_MANAGER_UNINITIALIZED,
                None,
            )
        })?;

    let models = manager.discover_models().await.map_err(|e| {
        CodedError::coded(
            format!("Failed to discover transcribe.cpp models: {}", e),
            TRANSCRIPTION_MODEL_DISCOVERY_FAILED,
            error_params(vec![("detail", serde_json::json!(e.to_string()))]),
        )
    })?;

    let model = match &requested_model {
        Some(requested) => {
            crate::transcribe_cpp_engine::transcription::select_requested_transcription_model(
                &models, requested,
            )
        }
        None => crate::transcribe_cpp_engine::transcription::select_transcription_model(
            &models,
            &configured_model,
        ),
    }
    .map_err(|not_ready| {
        warn!("❌ transcribeCpp model not ready: {}", not_ready);
        // One code per variant of the model-not-ready family (spec D7):
        // model name, percent and native detail travel in `params`.
        CodedError::from(not_ready)
    })?;

    info!(
        "Loading transcribeCpp model '{}' from {}",
        model.name,
        model.path.display()
    );

    // Library discovery, the ABI gate, backend registration and the model
    // load all block; keep them off the async runtime (transcribe.h: every
    // entry point blocks).
    let load_result = tokio::task::spawn_blocking(move || {
        crate::transcribe_cpp_engine::transcription::load_native_provider(&model, mode)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| {
        CodedError::coded(
            format!("transcribeCpp model load task failed: {}", e),
            TRANSCRIPTION_MODEL_LOAD_FAILED,
            error_params(vec![("detail", serde_json::json!(e.to_string()))]),
        )
    })?;

    match load_result {
        Ok(crate::transcribe_cpp_engine::transcription::NativeProviderLoad {
            provider,
            fell_back_to_cpu,
        }) => {
            info!(
                "✅ transcribeCpp provider ready: model '{}', requested mode '{}', backend '{}'",
                provider.model_name(),
                mode.as_str(),
                provider.backend()
            );
            // Vulkan requested but the engine runs on CPU: tell the user
            // through the existing warning channel (the worker's
            // "transcription-warning" event) and keep transcribing.
            if let Some(warning) =
                crate::transcribe_cpp_engine::transcription::vulkan_fallback_warning(
                    fell_back_to_cpu,
                )
            {
                warn!("⚠️ transcribeCpp Vulkan fallback: {}", warning);
                let _ = app.emit("transcription-warning", warning);
            }
            let cached =
                crate::transcribe_cpp_engine::transcription::set_provider(provider, mode);
            Ok(cached)
        }
        Err(message) => {
            warn!("❌ transcribeCpp model load failed: {}", message);
            // The native library's message is the diagnosable part: it stays
            // raw in `params.detail` (spec D7).
            Err(CodedError::coded(
                message.clone(),
                TRANSCRIPTION_MODEL_LOAD_FAILED,
                error_params(vec![("detail", serde_json::json!(message))]),
            ))
        }
    }
}

/// Get or initialize the transcribeCpp provider for a batch job
/// (retranscription or audio import), using the model exactly as requested.
///
/// Spec ticket 07: «без тихого фолбэка на другую установленную модель».
/// [`get_or_init_transcribe_cpp_provider_with_model`] keeps the configured-
/// wins fallback for `None` (the recording path needs it: a deleted model
/// must not block recording), so the batch entry resolves `None` to a
/// concrete name first — the dialog's choice, else the configured model,
/// else the catalog default — and always demands that exact model
/// ([`crate::transcribe_cpp_engine::transcription::select_requested_transcription_model`]):
/// not installed or not fully downloaded is an error surfaced through the
/// batch's existing error events, never a silent substitution of another
/// Available model.
pub async fn get_or_init_transcribe_cpp_provider_for_batch<R: Runtime>(
    app: &AppHandle<R>,
    requested_model: Option<String>,
) -> Result<Arc<dyn TranscriptionProvider>, CodedError> {
    // Read the transcript config directly (not through
    // api_get_transcript_config): the batch dialog may pick transcribeCpp
    // while the saved provider is something else, which is not an error —
    // it just means no configured model applies, and the catalog default
    // takes over (the same empty-model rule api_get_transcript_config uses).
    let (configured_provider, configured_model) =
        match crate::api::api::api_get_transcript_config(app.clone(), app.clone().state(), None)
            .await
        {
            Ok(Some(config)) => (config.provider, config.model),
            Ok(None) => (String::new(), String::new()),
            Err(e) => {
                warn!(
                    "⚠️ Failed to get transcript config for the transcribeCpp batch: {}",
                    e
                );
                (String::new(), String::new())
            }
        };

    let model = crate::transcribe_cpp_engine::transcription::batch_transcribe_cpp_model_name(
        requested_model.as_deref(),
        &configured_provider,
        &configured_model,
    );
    get_or_init_transcribe_cpp_provider_with_model(app, Some(model)).await
}

/// The saved transcribe.cpp compute mode ("Авто / Vulkan / CPU"), read through
/// the same transcript config the model comes from. Absent, unreadable or
/// unknown values mean Auto, matching the column's schema default.
async fn saved_transcribe_cpp_compute_mode<R: Runtime>(
    app: &AppHandle<R>,
) -> crate::transcribe_cpp_engine::backend::ComputeMode {
    use crate::transcribe_cpp_engine::backend::ComputeMode;
    match crate::api::api::api_get_transcript_config(app.clone(), app.clone().state(), None).await
    {
        Ok(Some(config)) => ComputeMode::parse(config.transcribe_backend.as_deref()),
        Ok(None) => ComputeMode::Auto,
        Err(e) => {
            warn!("⚠️ Failed to read the transcribeBackend setting, using auto: {}", e);
            ComputeMode::Auto
        }
    }
}

