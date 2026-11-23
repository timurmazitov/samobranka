// audio/transcription/mod.rs
//
// Transcription module: Provider abstraction, engine management, and worker pool.

pub mod audio_cpp_diarizer;
pub mod diarization;
pub mod diarization_run;
pub mod diarization_service;
pub mod engine;
pub mod provider;
pub mod transcribe_cpp_provider;
pub mod worker;

// Re-export commonly used types
pub use audio_cpp_diarizer::{AudioCppDiarizer, DiarizationError, DiarizerLoadError};
pub use diarization::{attribute_segments_to_speakers, SpeakerTurnInterval};
pub use diarization_service::{
    apply_speaker_labels, decide_diarization, diarize_recording_folder_with_model,
    installed_diarization_model, ran_segments, select_diarization_model, unavailable_for,
    DiarizationDecision, DiarizationOutcome, DiarizationStatus, DIARIZATION_UNAVAILABLE_CODE,
    SPEAKER_NAMES_RESET_CODE, SPEAKER_NAMES_RESET_EVENT,
};
pub use engine::{
    get_or_init_transcribe_cpp_provider, get_or_init_transcribe_cpp_provider_for_batch,
    get_or_init_transcribe_cpp_provider_with_model, get_or_init_transcription_engine,
    validate_transcription_model_ready, TranscriptionEngine, AUDIO_CPP_PROVIDER,
    TRANSCRIBE_CPP_PROVIDER,
};
pub use provider::{TranscriptResult, TranscriptionError, TranscriptionProvider};
pub use transcribe_cpp_provider::TranscribeCppProvider;
pub use worker::{reset_speech_detected_flag, start_transcription_task, TranscriptUpdate};
