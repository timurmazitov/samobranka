// audio/transcription/diarization_service.rs
//
// Orchestration for audioCpp diarization: resolve the diarization model from
// the catalog (if downloaded), run offline diarization over the whole
// recording, and overlay the speaker turns onto the transcript segments.
//
// The overlay itself is the pure function in `diarization.rs`; this module is
// the thin I/O layer around it. Diarization is strictly optional: when the
// Nemotron model is not installed the transcript is returned unchanged with a
// `no_model` status, so the UI can explain it instead of failing the
// transcription.

use std::path::Path;
use std::time::Instant;

use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Runtime};

use super::audio_cpp_diarizer::{AudioCppDiarizer, DiarizerLoadError};
use super::diarization::{attribute_segments_to_speakers, SpeakerTurnInterval};
use crate::audio_cpp_engine::catalog::{ModelInfo, ModelStatus, ModelTask};
use crate::audio_cpp_engine::engine::SAMPLE_RATE;
use crate::audio_cpp_engine::engine::load_native_engine;

/// Hint emitted (and shown to the user) when speaker labels were skipped
/// because the diarization model is not installed. One constant so the import,
/// retranscription and saved-meeting paths cannot drift apart, and so the
/// frontend has a single native text to mirror.
pub const DIARIZATION_UNAVAILABLE_MESSAGE: &str =
    "Speaker labels were skipped. Download the Nemotron-3-Diarization model in Settings to see who said what.";

/// Hint shown when the diarization model is installed but the audio.cpp
/// native library is not available on this machine.
pub const DIARIZATION_RUNTIME_UNAVAILABLE_MESSAGE: &str =
    "Speaker labels were skipped. The audio.cpp engine is unavailable on this system.";

/// Hint shown when diarization was attempted and the pass itself failed.
pub const DIARIZATION_FAILED_MESSAGE: &str =
    "Speaker labels were skipped because diarization failed.";

/// Event emitted (and shown to the user) when a recount of the speaker labels
/// removed every name the meeting had, so the names look lost on purpose.
/// One constant so the import, retranscription and saved-recording paths
/// cannot drift apart.
pub const SPEAKER_NAMES_RESET_EVENT: &str = "speaker-names-reset";

/// Text of the [`SPEAKER_NAMES_RESET_EVENT`] hint.
pub const SPEAKER_NAMES_RESET_MESSAGE: &str =
    "Speaker names were reset because the voices were recomputed.";

/// Native event announcing that a saved meeting's transcript gained speaker
/// labels. The meeting page subscribes to it instead of the old window event,
/// so a background pass can refresh an open meeting on its own.
pub const TRANSCRIPT_UPDATED_EVENT: &str = "transcript-updated";

/// Payload of [`TRANSCRIPT_UPDATED_EVENT`].
///
/// Pure so the shape is unit-tested without an `AppHandle`. `meeting_id`
/// is the only field the page matches on; `labeled_segments`/
/// `total_segments` let it show progress-free context and keep the event
/// self-describing for future listeners.
pub fn transcript_updated_payload(
    meeting_id: &str,
    labeled_segments: usize,
    total_segments: usize,
) -> serde_json::Value {
    serde_json::json!({
        "meeting_id": meeting_id,
        "labeled_segments": labeled_segments,
        "total_segments": total_segments,
    })
}

/// Why a diarization pass did or did not happen, as the UI sees it.
///
/// The five values are the whole contract: the UI no longer parses an error
/// text to tell "not configured" from "broken". `Ran` with zero labeled
/// segments is a successful pass over a recording with no distinguishable
/// voices, not a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiarizationStatus {
    /// The pass ran to completion; speaker labels reflect its output.
    Ran,
    /// No installed model for the diarization task.
    NoModel,
    /// The model is installed but the audio.cpp native library cannot load.
    NoRuntime,
    /// A recording is in progress; the pass would compete for memory.
    Deferred,
    /// The pass was attempted and failed (decode, load or engine error).
    Failed,
}

impl DiarizationStatus {
    /// Whether speaker labels are the output of a completed pass.
    ///
    /// This is the historical `speakers_available` flag: derived, never
    /// stored independently, so the two can never disagree.
    pub fn speakers_available(self) -> bool {
        matches!(self, Self::Ran)
    }
}

/// Outcome of the pure run decision.
#[derive(Debug, Clone)]
pub enum DiarizationDecision {
    /// Run one pass with this model.
    Run { model: ModelInfo },
    /// Do not run, for the given reason.
    DoNotRun(DiarizationStatus),
}

impl DiarizationDecision {
    /// Status this decision will report: `Ran` when the pass will run.
    pub fn status(&self) -> DiarizationStatus {
        match self {
            Self::Run { .. } => DiarizationStatus::Ran,
            Self::DoNotRun(status) => *status,
        }
    }
}

/// The single place that decides whether a diarization pass runs.
///
/// Inputs are the catalogued models, whether the native runtime is available,
/// and whether a recording is currently active. The priority is fixed by
/// tests and mirrors the spec: a missing model outranks an unavailable
/// runtime, and both outrank "a recording is active". Recording is only
/// checked before the pass loads the model, never after it started.
pub fn decide_diarization(
    models: &[ModelInfo],
    runtime_available: bool,
    recording_active: bool,
) -> DiarizationDecision {
    let Some(model) = select_diarization_model(models) else {
        return DiarizationDecision::DoNotRun(DiarizationStatus::NoModel);
    };
    if !runtime_available {
        return DiarizationDecision::DoNotRun(DiarizationStatus::NoRuntime);
    }
    if recording_active {
        return DiarizationDecision::DoNotRun(DiarizationStatus::Deferred);
    }
    DiarizationDecision::Run {
        model: model.clone(),
    }
}

/// Outcome of an optional diarization pass over a finished transcript.
#[derive(Debug, Clone, PartialEq)]
pub struct DiarizationOutcome {
    /// Speaker label per segment, aligned with the input segment order.
    /// `None` when diarization did not run for that segment.
    pub speakers: Vec<Option<String>>,
    /// Why the pass did or did not run.
    pub status: DiarizationStatus,
    /// True when a diarization model was installed and ran, so the UI can
    /// distinguish "no speakers found" from "diarization unavailable".
    /// Always equal to `status == Ran`; kept as a field for the call sites
    /// that still read the historical flag.
    pub speakers_available: bool,
    /// Diagnostic detail when diarization was attempted and failed. The
    /// transcript is still usable; this is for logs and the hint text.
    pub error: Option<String>,
}

impl DiarizationOutcome {
    fn new(
        speakers: Vec<Option<String>>,
        status: DiarizationStatus,
        error: Option<String>,
    ) -> Self {
        DiarizationOutcome {
            speakers,
            status,
            speakers_available: status.speakers_available(),
            error,
        }
    }

    /// Number of segments that received a speaker label.
    pub fn labeled_segments(&self) -> usize {
        self.speakers.iter().filter(|speaker| speaker.is_some()).count()
    }
}

/// An outcome for a pass that ran but attributed no speakers.
pub fn ran_segments(speakers: Vec<Option<String>>) -> DiarizationOutcome {
    DiarizationOutcome::new(speakers, DiarizationStatus::Ran, None)
}

/// Picks the installed diarization model, if any.
///
/// A model is usable only when it is catalogued for the `diar` task and its
/// artifact is fully installed. Missing/downloading/corrupted artifacts are
/// skipped rather than loaded.
pub fn select_diarization_model(models: &[ModelInfo]) -> Option<&ModelInfo> {
    models.iter().find(|model| {
        model.task == ModelTask::Diar && matches!(model.status, ModelStatus::Available)
    })
}

/// Resolves the installed diarization model from the shared catalog state.
///
/// The model manager is initialized at startup for every transcription
/// provider, so transcripts from older app versions find the model too. Returns
/// `None` when the manager is not initialized at all (unit tests, a failed
/// init) or when no diarization artifact is installed.
pub async fn installed_diarization_model() -> Option<ModelInfo> {
    let manager = crate::audio_cpp_engine::commands::model_manager()?;
    let models = manager.discover_models().await.ok()?;
    select_diarization_model(&models).cloned()
}

/// Applies an outcome's speaker labels to `segments` in order.
pub fn apply_speaker_labels(
    segments: &mut [crate::api::TranscriptSegment],
    outcome: &DiarizationOutcome,
) {
    for (segment, speaker) in segments.iter_mut().zip(outcome.speakers.iter()) {
        segment.speaker = speaker.clone();
    }
}

/// An outcome with no labels for the given non-`Ran` status.
pub fn unavailable_for(
    count: usize,
    status: DiarizationStatus,
    error: Option<String>,
) -> DiarizationOutcome {
    DiarizationOutcome::new(vec![None; count], status, error)
}

/// Diarizes a saved recording folder with an explicitly chosen model.
///
/// The caller owns the decision (see [`decide_diarization`]), so this never
/// re-resolves the catalog and therefore never turns a `no_model` decision
/// into a second, racing lookup.
///
/// `app` gives the pass access to the application event emitter so the stage
/// boundaries (decode, model load, inference) can announce progress without
/// restructuring the call chain. This function itself emits nothing today:
/// the existing terminal events stay owned by `diarization_run`, and the
/// emits must happen in these async wrappers, never on the engine's session
/// thread.
pub async fn diarize_recording_folder_with_model<R: Runtime>(
    app: &AppHandle<R>,
    folder: &Path,
    segments: &mut [crate::api::TranscriptSegment],
    model: &ModelInfo,
) -> DiarizationOutcome {
    let Some(audio_path) = crate::audio::common::find_audio_file(folder) else {
        warn!(
            "No audio file in {}; skipping diarization",
            folder.display()
        );
        return unavailable_for(
            segments.len(),
            DiarizationStatus::Failed,
            Some("recording audio not found".to_string()),
        );
    };

    let audio = match tokio::task::spawn_blocking(move || {
        crate::audio::decoder::decode_audio_file(&audio_path)
            .map(|decoded| decoded.to_whisper_format())
    })
    .await
    {
        Ok(Ok(audio)) => audio,
        Ok(Err(error)) => {
            warn!("Failed to decode recording for diarization: {}", error);
            return unavailable_for(
                segments.len(),
                DiarizationStatus::Failed,
                Some(error.to_string()),
            );
        }
        Err(error) => {
            warn!("Diarization decode task failed: {}", error);
            return unavailable_for(
                segments.len(),
                DiarizationStatus::Failed,
                Some(format!("decode task failed: {error}")),
            );
        }
    };

    let bounds: Vec<(f64, f64)> = segments
        .iter()
        .map(|segment| {
            (
                segment.audio_start_time.unwrap_or(0.0),
                segment.audio_end_time.unwrap_or(0.0),
            )
        })
        .collect();
    let outcome = run_and_overlay(app, &model.path, audio, &bounds).await;
    apply_speaker_labels(segments, &outcome);
    outcome
}

/// Runs the pass with an already resolved model and overlays the turns onto
/// `segment_bounds`.
async fn run_and_overlay<R: Runtime>(
    app: &AppHandle<R>,
    model_path: &Path,
    audio: Vec<f32>,
    segment_bounds: &[(f64, f64)],
) -> DiarizationOutcome {
    match run_diarization(app, model_path, audio).await {
        Ok(turns) => {
            let turns: Vec<SpeakerTurnInterval> = turns
                .into_iter()
                .map(|turn| {
                    SpeakerTurnInterval::new(
                        turn.start_sample as f64 / SAMPLE_RATE as f64,
                        turn.end_sample as f64 / SAMPLE_RATE as f64,
                        turn.speaker_id,
                    )
                })
                .collect();
            ran_segments(attribute_segments_to_speakers(segment_bounds, &turns))
        }
        Err(error) => {
            warn!(
                "audioCpp diarization failed; transcript keeps no speaker labels: {}",
                error
            );
            unavailable_for(
                segment_bounds.len(),
                DiarizationStatus::Failed,
                Some(error),
            )
        }
    }
}

/// Loads the diarization model on the native engine and runs one offline pass.
///
/// The library and model are released before returning, so a long diarization
/// does not pin the GPU/CPU memory of the transcription model.
///
/// `app` is the emitter handle for future stage-progress events; it is only
/// carried here so the boundary functions already have it. Nothing is emitted
/// yet, and the native load and inference stay on their blocking/session
/// threads — emits belong in this async wrapper, never inside `load_blocking`
/// or the session thread.
async fn run_diarization<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    audio: Vec<f32>,
) -> Result<Vec<crate::audio_cpp_engine::wrapper::SpeakerTurn>, String> {
    // Carried for the stage-progress emits of the following tickets; nothing
    // is emitted here yet, so the handle stays unused for now.
    let _ = &app;
    let path = path.to_path_buf();
    let model_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "diarization model".to_string());

    let diarizer = tokio::task::spawn_blocking(move || {
        let engine = load_native_engine().map_err(|error| error.to_string())?;
        AudioCppDiarizer::load_blocking(engine, model_name, &path)
            .map_err(|error: DiarizerLoadError| error.to_string())
    })
    .await
    .map_err(|error| format!("diarization load task failed: {error}"))??;

    let started = Instant::now();
    let turns = diarizer
        .diarize(audio)
        .await
        .map_err(|error| error.to_string())?;
    info!(
        "audioCpp diarization produced {} speaker turns in {} ms",
        turns.len(),
        started.elapsed().as_millis()
    );

    diarizer.unload();
    Ok(turns)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_cpp_engine::catalog;

    fn model(name: &str, status: ModelStatus) -> ModelInfo {
        catalog::find_model(name)
            .expect("catalogued")
            .model_info(Path::new("/models/audiocpp"), status)
    }

    #[test]
    fn an_installed_diarization_model_is_selected() {
        let models = vec![model("nemotron-3-diarization-bf16", ModelStatus::Available)];

        let selected = select_diarization_model(&models).unwrap();

        assert_eq!(selected.name, "nemotron-3-diarization-bf16");
        assert_eq!(selected.task, ModelTask::Diar);
    }

    #[test]
    fn a_missing_diarization_model_is_not_selected() {
        let models = vec![model("nemotron-3-diarization-bf16", ModelStatus::Missing)];

        assert!(select_diarization_model(&models).is_none());
    }

    #[test]
    fn a_corrupted_diarization_model_is_not_selected() {
        let models = vec![model(
            "nemotron-3-diarization-bf16",
            ModelStatus::Corrupted {
                file_size: 1,
                expected_min_size: 198_720_928,
            },
        )];

        assert!(select_diarization_model(&models).is_none());
    }

    #[test]
    fn only_a_fully_installed_diarization_model_is_selected() {
        // The catalog holds no ASR entries any more, so the task filter is a
        // compile-time guarantee (ModelTask has only Diar); what selection can
        // still reject on the seam is an artifact that is not Available.
        let models = vec![
            model(
                "nemotron-3-diarization-bf16",
                ModelStatus::Error("hash mismatch".to_string()),
            ),
            model(
                "nemotron-3-diarization-bf16",
                ModelStatus::Downloading { progress: 99 },
            ),
        ];

        assert!(select_diarization_model(&models).is_none());
    }

    #[test]
    fn a_downloading_diarization_model_is_not_selected() {
        let models = vec![model(
            "nemotron-3-diarization-bf16",
            ModelStatus::Downloading { progress: 42 },
        )];

        assert!(select_diarization_model(&models).is_none());
    }

    fn installed_diarization_model_for_test() -> ModelInfo {
        model("nemotron-3-diarization-bf16", ModelStatus::Available)
    }

    #[test]
    fn an_installed_model_and_runtime_while_idle_runs_the_pass() {
        let models = vec![installed_diarization_model_for_test()];

        let decision = decide_diarization(&models, true, false);

        match decision {
            DiarizationDecision::Run { model } => {
                assert_eq!(model.name, "nemotron-3-diarization-bf16")
            }
            other => panic!("expected a pass, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_model_outranks_an_unavailable_runtime() {
        let models = vec![model("nemotron-3-diarization-bf16", ModelStatus::Missing)];

        assert_eq!(
            decide_diarization(&models, false, false).status(),
            DiarizationStatus::NoModel
        );
    }

    #[test]
    fn a_missing_model_outranks_an_active_recording() {
        let models: Vec<ModelInfo> = Vec::new();

        assert_eq!(
            decide_diarization(&models, false, true).status(),
            DiarizationStatus::NoModel
        );
    }

    #[test]
    fn an_unavailable_runtime_outranks_an_active_recording() {
        let models = vec![installed_diarization_model_for_test()];

        assert_eq!(
            decide_diarization(&models, false, true).status(),
            DiarizationStatus::NoRuntime
        );
    }

    #[test]
    fn an_active_recording_defers_the_pass() {
        let models = vec![installed_diarization_model_for_test()];

        assert_eq!(
            decide_diarization(&models, true, true).status(),
            DiarizationStatus::Deferred
        );
    }

    #[test]
    fn an_empty_catalog_decides_no_model_and_leaves_every_segment_unlabelled() {
        // A session with no diarization model installed (for example, a
        // transcript from an older app version) has an empty catalog.
        // The decision must answer `no_model`, and the outcome it
        // maps to must leave the transcript untouched rather than fail it.
        let decision = decide_diarization(&[], true, false);
        assert_eq!(decision.status(), DiarizationStatus::NoModel);

        let outcome = unavailable_for(2, decision.status(), None);

        assert_eq!(outcome.speakers, vec![None, None]);
        assert!(!outcome.speakers_available);
        assert_eq!(outcome.status, DiarizationStatus::NoModel);
        assert!(outcome.error.is_none());
        assert_eq!(outcome.labeled_segments(), 0);
    }

    #[test]
    fn a_ran_pass_with_no_speakers_is_success_not_a_failure() {
        // "The pass ran, no voices were found" is a complete result, not an
        // error: the UI must not report a failure for a silent recording.
        let outcome = ran_segments(vec![None, None]);

        assert_eq!(outcome.status, DiarizationStatus::Ran);
        assert!(outcome.speakers_available);
        assert!(outcome.error.is_none());
        assert_eq!(outcome.labeled_segments(), 0);
    }

    #[test]
    fn speakers_available_is_derived_from_the_ran_status() {
        for (status, expected) in [
            (DiarizationStatus::Ran, true),
            (DiarizationStatus::NoModel, false),
            (DiarizationStatus::NoRuntime, false),
            (DiarizationStatus::Deferred, false),
            (DiarizationStatus::Failed, false),
        ] {
            assert_eq!(
                status.speakers_available(),
                expected,
                "status: {status:?}"
            );
        }
    }

    #[test]
    fn transcript_updated_payload_carries_the_meeting_id_and_segment_counts() {
        let payload = transcript_updated_payload("meeting-42", 7, 9);

        assert_eq!(payload["meeting_id"], "meeting-42");
        assert_eq!(payload["labeled_segments"], 7);
        assert_eq!(payload["total_segments"], 9);
        // The page matches on the id alone; no extra keys are invented that a
        // listener could mistake for a different contract.
        assert_eq!(
            payload.as_object().map(|object| object.len()),
            Some(3),
            "payload: {payload}"
        );
    }

    #[test]
    fn transcript_updated_payload_covers_a_ran_pass_with_no_labels() {
        let payload = transcript_updated_payload("meeting-7", 0, 4);

        assert_eq!(payload["meeting_id"], "meeting-7");
        assert_eq!(payload["labeled_segments"], 0);
        assert_eq!(payload["total_segments"], 4);
    }

    #[test]
    fn a_failed_outcome_keeps_existing_segments_unlabeled() {
        let mut segments = vec![crate::api::TranscriptSegment {
            id: "t1".to_string(),
            text: "hello".to_string(),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
            audio_start_time: Some(0.0),
            audio_end_time: Some(1.0),
            duration: Some(1.0),
            speaker: None,
        }];

        let outcome = unavailable_for(
            segments.len(),
            DiarizationStatus::Failed,
            Some("recording audio not found".into()),
        );
        apply_speaker_labels(&mut segments, &outcome);

        assert!(!outcome.speakers_available);
        assert_eq!(outcome.status, DiarizationStatus::Failed);
        assert_eq!(outcome.speakers, vec![None]);
        assert_eq!(segments[0].speaker, None);
        assert_eq!(outcome.error.as_deref(), Some("recording audio not found"));
    }
}
