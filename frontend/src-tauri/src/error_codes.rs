// error_codes.rs
//
// Stable machine-readable identifiers for user-facing Rust errors (native-i18n
// spec D7). This module is the **error-code registry**: every `code` value an
// event payload may carry is defined here, and the frontend resolves it through
// `t('transcription.errors.<code>', params)` (`frontend/src/lib/transcription-error.ts`,
// catalogs under `transcription.errors.*` in both locales).
//
// Rules (spec D7):
// - Codes are stable identifiers, never the English text; renaming a code is a
//   breaking change for older frontend translations and vice versa.
// - The English prose field (`userMessage`) stays in every payload: it feeds
//   logs and user screenshots and is the fallback when the frontend does not
//   know the code.
// - Interpolated values travel in `params` (model name, percent). Native
//   library detail stays raw in `params.detail` and is displayed as-is.
// - Payload key casing follows the hand-built `json!` norm of each payload:
//   `userMessage` camelCase, everything else — including `code` and `params`
//   — snake_case.
//
// Registry (dot-namespace = the frontend key suffix under
// `transcription.errors.`; "params" lists the keys of the payload `params`
// object):
//
// | Code                                       | Emitted by                                      | params                      |
// | ------------------------------------------ | ----------------------------------------------- | --------------------------- |
// | transcription.engine_init_failed           | worker.rs engine-init failure                   | —                           |
// | transcription.runtime_unavailable          | recording_commands.rs runtime-start failure    | —                           |
// | transcription.model_not_installed          | ModelNotReady::NoModelInstalled                 | —                           |
// | transcription.model_not_found              | ModelNotReady::NotFound                         | model                       |
// | transcription.model_not_downloaded         | ModelNotReady::Status(Missing)                  | model                       |
// | transcription.model_downloading            | ModelNotReady::Status(Downloading)              | model, percent              |
// | transcription.model_corrupted              | ModelNotReady::Status(Corrupted)                | model                       |
// | transcription.model_errored                | ModelNotReady::Status(Error)                    | model, detail               |
// | transcription.provider_not_loaded          | TranscriptionError::ModelNotLoaded              | —                           |
// | transcription.audio_too_short              | TranscriptionError::AudioTooShort (counted in   | samples, minimum            |
// |                                            | worker.rs, not emitted; coded for family        |                             |
// |                                            | completeness)                                   |                             |
// | transcription.engine_failed                | TranscriptionError::EngineFailed                | detail                      |
// | transcription.language_unsupported         | TranscriptionError::UnsupportedLanguage         | language                    |
// | transcription.model_manager_uninitialized  | engine.rs model manager missing                 | —                           |
// | transcription.model_discovery_failed       | engine.rs discover_models failure               | detail                      |
// | transcription.model_load_failed            | engine.rs native model load failure             | detail                      |
//
// `audio/import.rs` and `audio/retranscription.rs` fold the same provider and
// model failures into their own `*-error` events as raw prose strings; that
// chain is outside this ticket's payload scope (those payloads carry no
// `code` field to add to) and keeps its English prose.

use serde_json::{json, Map, Value};

use crate::audio::transcription::provider::TranscriptionError;
use crate::transcribe_cpp_engine::catalog::ModelStatus;
use crate::transcribe_cpp_engine::transcription::ModelNotReady;

/// Engine-init failure in the live transcription worker (`worker.rs`).
pub const TRANSCRIPTION_ENGINE_INIT_FAILED: &str = "transcription.engine_init_failed";
/// Speech recognition could not initialize at recording start
/// (`recording_commands.rs`, the `TRANSCRIPTION_RUNTIME_*` path).
pub const TRANSCRIPTION_RUNTIME_UNAVAILABLE: &str = "transcription.runtime_unavailable";

/// No catalogued transcribe.cpp model is installed
/// (`transcribe_cpp_engine/transcription.rs`, `ModelNotReady::NoModelInstalled`).
pub const TRANSCRIPTION_MODEL_NOT_INSTALLED: &str = "transcription.model_not_installed";
/// The requested model is not in the catalog at all (`ModelNotReady::NotFound`),
/// model name in `model`.
pub const TRANSCRIPTION_MODEL_NOT_FOUND: &str = "transcription.model_not_found";
/// The model artifact is absent on disk (`ModelStatus::Missing`), model in `model`.
pub const TRANSCRIPTION_MODEL_NOT_DOWNLOADED: &str = "transcription.model_not_downloaded";
/// The model is still downloading (`ModelStatus::Downloading`), model in
/// `model`, percent in `percent`.
pub const TRANSCRIPTION_MODEL_DOWNLOADING: &str = "transcription.model_downloading";
/// The model artifact is corrupted (`ModelStatus::Corrupted`), model in `model`.
pub const TRANSCRIPTION_MODEL_CORRUPTED: &str = "transcription.model_corrupted";
/// The model artifact carries a native error (`ModelStatus::Error`), model in
/// `model`, raw native tail in `detail`.
pub const TRANSCRIPTION_MODEL_ERRORED: &str = "transcription.model_errored";

/// No transcription model is loaded (`TranscriptionError::ModelNotLoaded`).
pub const TRANSCRIPTION_PROVIDER_NOT_LOADED: &str = "transcription.provider_not_loaded";
/// The speech window is below the engine minimum
/// (`TranscriptionError::AudioTooShort`), counts in `samples`/`minimum`.
pub const TRANSCRIPTION_AUDIO_TOO_SHORT: &str = "transcription.audio_too_short";
/// The native engine failed mid-transcription
/// (`TranscriptionError::EngineFailed`), native message in `detail`.
pub const TRANSCRIPTION_ENGINE_FAILED: &str = "transcription.engine_failed";
/// The provider cannot handle the requested language
/// (`TranscriptionError::UnsupportedLanguage`), language tag in `language`.
pub const TRANSCRIPTION_LANGUAGE_UNSUPPORTED: &str = "transcription.language_unsupported";

/// The transcribe.cpp model manager is not initialized (`engine.rs`).
pub const TRANSCRIPTION_MODEL_MANAGER_UNINITIALIZED: &str =
    "transcription.model_manager_uninitialized";
/// `discover_models` failed (`engine.rs`), native cause in `detail`.
pub const TRANSCRIPTION_MODEL_DISCOVERY_FAILED: &str = "transcription.model_discovery_failed";
/// The native model load failed (`engine.rs`), native message in `detail`.
pub const TRANSCRIPTION_MODEL_LOAD_FAILED: &str = "transcription.model_load_failed";

/// Builds the `params` object for an error payload. Omit `params` from the
/// `json!` map entirely when this returns `None` (codes without interpolated
/// values carry no `params` key at all).
pub fn error_params(entries: Vec<(&'static str, Value)>) -> Option<Value> {
    if entries.is_empty() {
        return None;
    }
    let mut map = Map::with_capacity(entries.len());
    for (key, value) in entries {
        map.insert(key.to_string(), value);
    }
    Some(Value::Object(map))
}

/// An error that travels to the frontend with a stable code beside its prose
/// (native-i18n spec D7).
///
/// Replaces the bare `String` errors of the transcription-init chain so the
/// emitters can add `code`/`params` without re-parsing prose. `message` keeps
/// the exact English text the `String` carried: it still reaches logs, the
/// `error`/`userMessage` payload fields and command `Err` values, and it is
/// what the frontend renders for a code it does not know.
#[derive(Debug, Clone)]
pub struct CodedError {
    /// The full English prose, byte-for-byte what the `String` error carried.
    pub message: String,
    /// Stable frontend-resolvable code, or `None` for internal bugs whose
    /// prose no catalog key words (the frontend shows `message` for those).
    pub code: Option<&'static str>,
    /// Interpolated values for the catalog sentence (model, percent, detail).
    pub params: Option<Value>,
}

impl CodedError {
    /// An internal-bug error without a code: the prose is the whole message.
    pub fn plain(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            params: None,
        }
    }

    /// A coded error with interpolated values (see [`error_params`]).
    pub fn coded(message: impl Into<String>, code: &'static str, params: Option<Value>) -> Self {
        Self {
            message: message.into(),
            code: Some(code),
            params,
        }
    }

    /// Attach a code to an otherwise-plain error (used where the error text
    /// is built at the emit site, e.g. the worker's wrapped provider error).
    pub fn with_code(mut self, code: &'static str, params: Option<Value>) -> Self {
        self.code = Some(code);
        self.params = params;
        self
    }
}

impl std::fmt::Display for CodedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for CodedError {}

impl From<ModelNotReady> for CodedError {
    fn from(not_ready: ModelNotReady) -> Self {
        let (code, params) = match &not_ready {
            ModelNotReady::NoModelInstalled => (TRANSCRIPTION_MODEL_NOT_INSTALLED, vec![]),
            ModelNotReady::NotFound { model } => (
                TRANSCRIPTION_MODEL_NOT_FOUND,
                vec![("model", json!(model))],
            ),
            ModelNotReady::Status { model, status } => match status {
                ModelStatus::Missing => (
                    TRANSCRIPTION_MODEL_NOT_DOWNLOADED,
                    vec![("model", json!(model))],
                ),
                ModelStatus::Downloading { progress } => (
                    TRANSCRIPTION_MODEL_DOWNLOADING,
                    vec![("model", json!(model)), ("percent", json!(progress))],
                ),
                ModelStatus::Corrupted { .. } => (
                    TRANSCRIPTION_MODEL_CORRUPTED,
                    vec![("model", json!(model))],
                ),
                ModelStatus::Error(detail) => (
                    TRANSCRIPTION_MODEL_ERRORED,
                    vec![("model", json!(model)), ("detail", json!(detail))],
                ),
                ModelStatus::Available => {
                    // `Available` is never a "not ready" state; the Display
                    // impl renders it as empty prose. Keep it codeless so the
                    // frontend falls back to whatever prose arrived.
                    return Self::plain(not_ready.to_string());
                }
            },
        };
        Self::coded(not_ready.to_string(), code, error_params(params))
    }
}

impl From<TranscriptionError> for CodedError {
    fn from(error: TranscriptionError) -> Self {
        let (code, params) = match &error {
            TranscriptionError::ModelNotLoaded => (TRANSCRIPTION_PROVIDER_NOT_LOADED, vec![]),
            TranscriptionError::AudioTooShort { samples, minimum } => (
                TRANSCRIPTION_AUDIO_TOO_SHORT,
                vec![("samples", json!(samples)), ("minimum", json!(minimum))],
            ),
            TranscriptionError::EngineFailed(msg) => {
                (TRANSCRIPTION_ENGINE_FAILED, vec![("detail", json!(msg))])
            }
            TranscriptionError::UnsupportedLanguage(lang) => (
                TRANSCRIPTION_LANGUAGE_UNSUPPORTED,
                vec![("language", json!(lang))],
            ),
        };
        Self::coded(error.to_string(), code, error_params(params))
    }
}

/// Builds the standard `transcription-error` event payload (native-i18n
/// spec D7). One builder keeps every emission in this chain the same shape:
/// the hand-built `json!` norm where `userMessage` is the only camelCase key
/// and `code`/`params` are plain. `actionable` and `phase` keep their exact
/// meaning — listeners branch on them to choose the UI surface and whether a
/// failed transcription stops the recording; this builder only ever adds keys.
///
/// A `None` code/params serializes to JSON `null`; the frontend treats null
/// like an absent code and falls back to `userMessage`.
pub fn transcription_error_payload(
    error: impl Into<String>,
    user_message: impl Into<String>,
    actionable: bool,
    phase: &str,
    code: Option<&'static str>,
    params: Option<Value>,
) -> Value {
    json!({
        "error": error.into(),
        "userMessage": user_message.into(),
        "actionable": actionable,
        "phase": phase,
        "code": code,
        "params": params,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::transcription::provider::TranscriptionError;
    use crate::transcribe_cpp_engine::catalog::ModelStatus;
    use crate::transcribe_cpp_engine::transcription::ModelNotReady;

    #[test]
    fn error_params_omits_the_key_when_there_is_nothing_to_interpolate() {
        assert_eq!(error_params(vec![]), None);
    }

    #[test]
    fn error_params_builds_an_object_of_the_given_entries() {
        assert_eq!(
            error_params(vec![
                ("model", json!("parakeet-ultra-Q8_0")),
                ("percent", json!(42)),
            ]),
            Some(json!({ "model": "parakeet-ultra-Q8_0", "percent": 42 }))
        );
    }

    #[test]
    fn payload_keeps_the_listener_contract_and_carries_code_and_params() {
        // The hand-built shape the TS mirror promises: `userMessage` is the
        // only camelCase key; `code`/`params` are plain snake_case. Adding
        // keys must never disturb `actionable`/`phase` (spec D7: behaviour
        // keys off them).
        let payload = transcription_error_payload(
            "Transcribe.cpp model 'm' is still downloading (42%). Please wait for it to finish.",
            "Recording cannot start: Transcribe.cpp model 'm' is still downloading (42%). Please wait for it to finish.",
            false,
            "startup",
            Some(TRANSCRIPTION_MODEL_DOWNLOADING),
            error_params(vec![("model", json!("m")), ("percent", json!(42))]),
        );
        assert_eq!(
            payload,
            json!({
                "error": "Transcribe.cpp model 'm' is still downloading (42%). Please wait for it to finish.",
                "userMessage": "Recording cannot start: Transcribe.cpp model 'm' is still downloading (42%). Please wait for it to finish.",
                "actionable": false,
                "phase": "startup",
                "code": "transcription.model_downloading",
                "params": { "model": "m", "percent": 42 },
            })
        );
    }

    #[test]
    fn payload_without_a_code_stays_resolvable_by_the_prose_fallback() {
        // Internal-bug messages carry no code: the keys are still there (as
        // null) so one TS shape covers every emission, and the frontend
        // falls back to `userMessage`.
        let payload = transcription_error_payload("bug", "Recording failed: bug", true, "active", None, None);
        assert_eq!(payload["code"], Value::Null);
        assert_eq!(payload["params"], Value::Null);
        assert_eq!(payload["userMessage"], "Recording failed: bug");
        assert_eq!(payload["actionable"], json!(true));
        assert_eq!(payload["phase"], "active");
    }

    #[test]
    fn model_not_ready_variants_carry_their_stable_code_and_params() {
        let cases: Vec<(ModelNotReady, &str, Option<Value>)> = vec![
            (
                ModelNotReady::NoModelInstalled,
                "transcription.model_not_installed",
                None,
            ),
            (
                ModelNotReady::NotFound {
                    model: "removed-model".into(),
                },
                "transcription.model_not_found",
                Some(json!({ "model": "removed-model" })),
            ),
            (
                ModelNotReady::Status {
                    model: "parakeet-ultra-Q8_0".into(),
                    status: ModelStatus::Missing,
                },
                "transcription.model_not_downloaded",
                Some(json!({ "model": "parakeet-ultra-Q8_0" })),
            ),
            (
                ModelNotReady::Status {
                    model: "parakeet-ultra-Q8_0".into(),
                    status: ModelStatus::Downloading { progress: 42 },
                },
                "transcription.model_downloading",
                Some(json!({ "model": "parakeet-ultra-Q8_0", "percent": 42 })),
            ),
            (
                ModelNotReady::Status {
                    model: "parakeet-ultra-Q8_0".into(),
                    status: ModelStatus::Corrupted {
                        file_size: 1,
                        expected_min_size: 2,
                    },
                },
                "transcription.model_corrupted",
                Some(json!({ "model": "parakeet-ultra-Q8_0" })),
            ),
            (
                ModelNotReady::Status {
                    model: "parakeet-ultra-Q8_0".into(),
                    status: ModelStatus::Error("bad gguf header".into()),
                },
                "transcription.model_errored",
                Some(json!({ "model": "parakeet-ultra-Q8_0", "detail": "bad gguf header" })),
            ),
        ];

        for (not_ready, expected_code, expected_params) in cases {
            let coded = CodedError::from(not_ready.clone());
            assert_eq!(coded.code, Some(expected_code));
            assert_eq!(coded.params, expected_params);
            // The prose must survive verbatim in `message` — it is what logs
            // and screenshots show (spec D7), so Display and `message` agree.
            assert_eq!(coded.message, not_ready.to_string());
        }
    }

    #[test]
    fn transcription_error_variants_carry_their_stable_code_and_params() {
        let cases: Vec<(TranscriptionError, &str, Option<Value>)> = vec![
            (
                TranscriptionError::ModelNotLoaded,
                "transcription.provider_not_loaded",
                None,
            ),
            (
                TranscriptionError::AudioTooShort {
                    samples: 10,
                    minimum: 1600,
                },
                "transcription.audio_too_short",
                Some(json!({ "samples": 10, "minimum": 1600 })),
            ),
            (
                TranscriptionError::EngineFailed("native boom".into()),
                "transcription.engine_failed",
                Some(json!({ "detail": "native boom" })),
            ),
            (
                TranscriptionError::UnsupportedLanguage("de".into()),
                "transcription.language_unsupported",
                Some(json!({ "language": "de" })),
            ),
        ];

        for (error, expected_code, expected_params) in cases {
            let coded = CodedError::from(error.clone());
            assert_eq!(coded.code, Some(expected_code));
            assert_eq!(coded.params, expected_params);
            assert_eq!(coded.message, error.to_string());
        }
    }

    #[test]
    fn plain_coded_errors_carry_no_code_so_the_frontend_shows_the_prose() {
        let coded = CodedError::plain("Cannot initialize transcribeCpp: provider mismatch");
        assert_eq!(coded.code, None);
        assert_eq!(coded.params, None);
        assert_eq!(coded.to_string(), "Cannot initialize transcribeCpp: provider mismatch");
    }
}
