// audio/transcription/diarization_run.rs
//
// One operation: "diarize a saved meeting". Every caller that produces a
// meeting — the manual command, import, retranscription — goes through it, so
// the run decision, the label write, the speaker-name recount and the events
// exist once.
//
// The pass itself lives in `diarization_service` (pure overlay + the audio.cpp
// run). This module is the orchestration around it and owns the rules that
// belong to a *saved* meeting: the process-wide serialization of passes, the
// recording guard, and the native `transcript-updated` event.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use log::{info, warn};
use once_cell::sync::Lazy;
use sqlx::{Connection, SqlitePool};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use super::diarization_service::{
    decide_diarization, diarization_progress_event, emit_pass_progress, transcript_updated_payload,
    DiarizationDecision, DiarizationPhase, DiarizationStatus, DIARIZATION_DEFERRED_CODE,
    DIARIZATION_FAILED_CODE, DIARIZATION_RUNTIME_UNAVAILABLE_CODE, DIARIZATION_UNAVAILABLE_CODE,
    SPEAKER_NAMES_RESET_CODE, SPEAKER_NAMES_RESET_EVENT, TRANSCRIPT_UPDATED_EVENT,
};
use crate::database::repositories::meeting::MeetingsRepository;
use crate::database::repositories::speaker;

/// Event emitted when a saved meeting could not be diarized.
pub const DIARIZATION_UNAVAILABLE_EVENT: &str = "diarization-unavailable";

/// Serializes diarization passes process-wide: at most one pass runs at a
/// time, because a second copy of the model in memory is exactly what the
/// spec wants to avoid. Deliberately separate from the transcription-engine
/// lifecycle lock (`audio::common`): a model unload after a batch job must not
/// block or cancel a running pass.
static DIARIZATION_PASS_LOCK: Lazy<Arc<AsyncMutex<()>>> =
    Lazy::new(|| Arc::new(AsyncMutex::new(())));

async fn acquire_pass_lock() -> OwnedMutexGuard<()> {
    DIARIZATION_PASS_LOCK.clone().lock_owned().await
}

/// Result of diarizing one saved meeting.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedMeetingDiarization {
    pub meeting_id: String,
    /// Why the pass did or did not run.
    pub status: DiarizationStatus,
    /// Transcript segments that received a speaker label.
    pub labeled_segments: usize,
    pub total_segments: usize,
    /// Diagnostic detail for `Failed`; never user-facing prose.
    pub error: Option<String>,
}

impl SavedMeetingDiarization {
    /// The historical availability flag, derived so it cannot disagree with
    /// the status.
    pub fn speakers_available(&self) -> bool {
        self.status.speakers_available()
    }
}

/// One notification a finished pass owes the UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiarizationEvent {
    /// Speaker labels reached the database; the open meeting should refetch.
    TranscriptUpdated {
        meeting_id: String,
        labeled_segments: usize,
        total_segments: usize,
    },
    /// The pass was attempted and failed. Configuration reasons
    /// (`no_model`, `no_runtime`, `deferred`) are deliberately absent here:
    /// the user did not ask for those passes. The one exception is a pass
    /// that had already announced its `queued` stage and then deferred —
    /// see [`deferred_after_queue_events`], because a surface that saw the
    /// stage would otherwise wait for a terminal that never comes.
    Unavailable {
        meeting_id: String,
        status: DiarizationStatus,
        error: Option<String>,
    },
    /// The recount removed every name the meeting had.
    SpeakerNamesReset { meeting_id: String },
}

/// State code for a `diarization-unavailable` announcement.
///
/// The frontend catalog resolves the code to the user-facing sentence
/// (native-i18n spec D8); missing model and missing runtime send different
/// codes on purpose so the user knows what to fix. The event itself fires for
/// `failed` and for a pass that deferred after announcing `queued` (see
/// [`deferred_after_queue_events`]); the `NoModel`/`NoRuntime` arms stay
/// because the event's contract keeps them addressable, and the mapping is
/// pinned by tests — on this side by the payload tests below and on the
/// frontend by `tests/lib/live-diarization.test.ts`.
pub fn unavailable_code(status: DiarizationStatus) -> &'static str {
    match status {
        DiarizationStatus::NoRuntime => DIARIZATION_RUNTIME_UNAVAILABLE_CODE,
        DiarizationStatus::NoModel => DIARIZATION_UNAVAILABLE_CODE,
        DiarizationStatus::Deferred => DIARIZATION_DEFERRED_CODE,
        DiarizationStatus::Failed | DiarizationStatus::Ran => DIARIZATION_FAILED_CODE,
    }
}

/// The notifications a result owes, in order, without an `AppHandle`.
///
/// Pure so the announcement rules are unit-tested: `ran` (even with zero
/// labels) refreshes the transcript, `failed` explains itself, and the three
/// configuration statuses stay silent.
pub fn diarization_events(
    result: &SavedMeetingDiarization,
    names_reset: bool,
) -> Vec<DiarizationEvent> {
    let mut events = Vec::new();
    match result.status {
        DiarizationStatus::Ran => {
            events.push(DiarizationEvent::TranscriptUpdated {
                meeting_id: result.meeting_id.clone(),
                labeled_segments: result.labeled_segments,
                total_segments: result.total_segments,
            });
            if names_reset {
                events.push(DiarizationEvent::SpeakerNamesReset {
                    meeting_id: result.meeting_id.clone(),
                });
            }
        }
        DiarizationStatus::Failed => events.push(DiarizationEvent::Unavailable {
            meeting_id: result.meeting_id.clone(),
            status: result.status,
            error: result.error.clone(),
        }),
        DiarizationStatus::NoModel | DiarizationStatus::NoRuntime | DiarizationStatus::Deferred => {
        }
    }
    events
}

/// The terminal a pass owes when it deferred *after* announcing `queued`.
///
/// The general `deferred` config reason stays silent (see
/// [`diarization_events`]): a pass the decision postponed before it spoke
/// owes the UI nothing. But once a surface has seen `queued` it is waiting on
/// a terminal, and the under-lock recording re-check can still answer
/// `deferred` — without this terminal the bar/indicator would hang in
/// running forever. The payload reuses the `diarization-unavailable` channel
/// with the `deferred` status; the frontend ends a non-`failed` payload on
/// that channel without a toast, so this reads as an honest, silent stop.
///
/// Pure so the rule is unit-tested beside the silence rule it complements.
pub fn deferred_after_queue_events(
    meeting_id: &str,
    announced_queued: bool,
) -> Vec<DiarizationEvent> {
    if !announced_queued {
        return Vec::new();
    }
    vec![DiarizationEvent::Unavailable {
        meeting_id: meeting_id.to_string(),
        status: DiarizationStatus::Deferred,
        error: None,
    }]
}

/// What happened to a pass that ran after the batch job had already finished.

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BackgroundPassOutcome {
    /// The pass reached a status; configuration reasons and failures all land
    /// here, because the pass reports them in-band.
    Finished(DiarizationStatus),
    /// The pass could not even start (missing meeting, database failure).
    CouldNotRun(String),
}

/// Collapses the result of a background pass into something the caller can log
/// without ever turning it into a batch error.
///
/// An `Err` here means the meeting row or its audio could not be read — after
/// `create_meeting_with_transcripts`/the transcript commit succeeded. Losing
/// the import because diarization could not start would trade the transcript
/// for an optional second stage, which the spec forbids.
pub(crate) fn background_pass_outcome(
    result: Result<SavedMeetingDiarization, String>,
) -> BackgroundPassOutcome {
    match result {
        Ok(finished) => BackgroundPassOutcome::Finished(finished.status),
        Err(error) => BackgroundPassOutcome::CouldNotRun(error),
    }
}

/// Runs the shared pass in the background and logs its outcome.
///
/// `run` is the boundary that produces the real pass; injecting it keeps the
/// "never fails the batch" rule testable without GGUF weights, a native
/// library or a Tauri app handle.
pub(crate) async fn run_scheduled_diarization<F, Fut>(
    meeting_id: &str,
    run: F,
) -> BackgroundPassOutcome
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<SavedMeetingDiarization, String>>,
{
    let outcome = background_pass_outcome(run().await);
    match &outcome {
        BackgroundPassOutcome::Finished(status) => {
            info!("Background diarization of {meeting_id} finished: {status:?}");
        }
        BackgroundPassOutcome::CouldNotRun(error) => {
            warn!("Background diarization of {meeting_id} could not start: {error}");
        }
    }
    outcome
}

/// Schedules the post-save pass on Tauri's async runtime and returns at once.
///
/// Import and retranscription call this after the meeting row and its
/// transcript are committed, so the user gets the meeting immediately instead
/// of waiting for a pass they did not order. There is no engine parameter: the
/// old `engine_kind == AudioCpp` gate is gone, and [`diarize_saved_meeting`]
/// decides on its own whether a pass can run. The task is detached on purpose:
///
/// * It does not hold `audio::common`'s engine-lifecycle lock, so
///   `unload_engine_after_batch` can run while the pass runs; the pass loads
///   the native library and the Nemotron model itself and releases them
///   before it returns. The two paths touch no shared lock, so neither can
///   wait on the other.
/// * It does not read the import/retranscription cancellation flags, so
///   releasing `ImportGuard`/`RetranscriptionGuard` cannot cancel it.
/// * It never rejects the caller's future: [`run_scheduled_diarization`]
///   resolves even when the pass cannot start.
///
/// The spawned handle is returned so a test can await the very work a batch job
/// leaves behind; production drops it.
pub(crate) fn schedule_saved_meeting<R: Runtime>(
    app: AppHandle<R>,
    pool: SqlitePool,
    meeting_id: String,
) -> tauri::async_runtime::JoinHandle<BackgroundPassOutcome> {
    tauri::async_runtime::spawn(async move {
        run_scheduled_diarization(&meeting_id, || async {
            diarize_saved_meeting(&app, &pool, &meeting_id).await
        })
        .await
    })
}

/// The result of a pass whose labels could not be written.
///
/// The pass itself succeeded, so the status is `Failed` in-band — never an
/// `Err`: the caller's transcript is already saved and losing the batch job
/// because the label write broke would trade a transcript for an optional
/// second stage.
pub(crate) fn label_write_failure(
    meeting_id: &str,
    total_segments: usize,
    error: String,
) -> SavedMeetingDiarization {
    SavedMeetingDiarization {
        meeting_id: meeting_id.to_string(),
        status: DiarizationStatus::Failed,
        labeled_segments: 0,
        total_segments,
        error: Some(error),
    }
}

/// Emits a planned event list. Failures only log: the meeting is already
/// saved and the labels are already in the database.
fn emit_events<R: Runtime>(app: &AppHandle<R>, events: &[DiarizationEvent]) {
    for event in events {
        match event {
            DiarizationEvent::TranscriptUpdated {
                meeting_id,
                labeled_segments,
                total_segments,
            } => {
                if let Err(error) = app.emit(
                    TRANSCRIPT_UPDATED_EVENT,
                    transcript_updated_payload(meeting_id, *labeled_segments, *total_segments),
                ) {
                    warn!("Failed to emit transcript update for {meeting_id}: {error}");
                }
            }
            DiarizationEvent::Unavailable {
                meeting_id,
                status,
                error,
            } => {
                if let Err(emit_error) = app.emit(
                    DIARIZATION_UNAVAILABLE_EVENT,
                    serde_json::json!({
                        "meeting_id": meeting_id,
                        "status": status,
                        "reason": error,
                        // State code, not prose (native-i18n spec D8): the
                        // frontend catalog renders the sentence. The old
                        // `message` field is gone because no listener renders
                        // it anymore (grep-proven at ticket 07): the toasts
                        // resolve the code, and the pass-state reducer keeps
                        // reading `message` only as a diagnostic fallback for
                        // payloads from an older build.
                        "code": unavailable_code(*status),
                    }),
                ) {
                    warn!("Failed to emit diarization-unavailable for {meeting_id}: {emit_error}");
                }
            }
            DiarizationEvent::SpeakerNamesReset { meeting_id } => {
                if let Err(error) = app.emit(
                    SPEAKER_NAMES_RESET_EVENT,
                    serde_json::json!({
                        "meeting_id": meeting_id,
                        "code": SPEAKER_NAMES_RESET_CODE,
                    }),
                ) {
                    warn!("Failed to emit speaker-names-reset for {meeting_id}: {error}");
                }
            }
        }
    }
}

/// Replaces a meeting's speaker labels and recounts its names in one
/// transaction, so a name can never outlive the label it is bound to.
///
/// Returns whether the recount dropped at least one existing name.
async fn persist_speaker_labels(
    pool: &SqlitePool,
    meeting_id: &str,
    segments: &[crate::api::TranscriptSegment],
) -> Result<bool, String> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|error| format!("Database error: {error}"))?;
    let mut tx = conn
        .begin()
        .await
        .map_err(|error| format!("Failed to start transaction: {error}"))?;
    for segment in segments {
        sqlx::query("UPDATE transcripts SET speaker = ? WHERE id = ?")
            .bind(&segment.speaker)
            .bind(&segment.id)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("Failed to update speaker label: {error}"))?;
    }
    let reconcile = speaker::reconcile_meeting_speaker_assignments(&mut tx, meeting_id)
        .await
        .map_err(|error| format!("Failed to reconcile speaker names: {error}"))?;
    tx.commit()
        .await
        .map_err(|error| format!("Failed to commit speaker labels: {error}"))?;
    Ok(reconcile.names_reset)
}

/// Mirrors freshly committed speaker labels into the meeting's
/// `transcripts.json`.
///
/// Both batch paths and the recording saver write that file before a pass
/// runs, so without this the export would keep `speaker: null` for every
/// segment while the database has the labels — the file would silently
/// diverge from the meeting. The write is blocking file I/O, so it runs on a
/// blocking thread instead of the async runtime. A failure here only logs: the
/// labels are already committed, and a stale export must not turn a successful
/// pass into a failure.
async fn rewrite_transcripts_json(folder: &Path, segments: Vec<crate::api::TranscriptSegment>) {
    let folder = folder.to_path_buf();
    let written = tokio::task::spawn_blocking(move || {
        crate::audio::common::write_transcripts_json(&folder, &segments)
    })
    .await;
    match written {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            warn!("Failed to rewrite transcripts.json: {error}");
        }
        Err(error) => {
            warn!("transcripts.json rewrite task failed: {error}");
        }
    }
}

/// Announces the deferred terminal for a pass that had already announced
/// `queued` and returns the in-band result. Separate from
/// [`diarize_saved_meeting`] so the announce-and-return step is testable
/// against the mock app without a model catalog or a recording to race.
fn deferred_after_queued<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    total_segments: usize,
) -> SavedMeetingDiarization {
    let result = SavedMeetingDiarization {
        meeting_id: meeting_id.to_string(),
        status: DiarizationStatus::Deferred,
        labeled_segments: 0,
        total_segments,
        error: None,
    };
    // The pass already announced `queued`, so this `deferred` is not the
    // silent config reason: it must land as a terminal or the waiting
    // surface hangs in running forever.
    emit_events(app, &deferred_after_queue_events(meeting_id, true));
    result
}

/// Diarizes a saved meeting: decide, run one pass over the meeting's audio
/// file, persist the labels with the speaker-name recount, and emit the
/// native events.
///
/// The pass decodes the meeting file itself and releases the native library
/// and model before returning. A configuration reason (`no_model`,
/// `no_runtime`, `deferred`) is a normal result, not an error; only database
/// failures and a missing meeting are `Err`.
pub async fn diarize_saved_meeting<R: Runtime>(
    app: &AppHandle<R>,
    pool: &SqlitePool,
    meeting_id: &str,
) -> Result<SavedMeetingDiarization, String> {
    // The meeting is read before the queue: its segment count is part of
    // every result, including the ones that never run a pass, and the
    // speakers panel shows it. A cheap database read does not compete with
    // an active recording, so it does not have to wait for the lock.
    let meeting = MeetingsRepository::get_meeting(pool, meeting_id)
        .await
        .map_err(|error| format!("Failed to load meeting: {error}"))?
        .ok_or_else(|| format!("Meeting not found: {meeting_id}"))?;
    let total_segments = meeting.transcripts.len();

    // The decision runs before the queue so a pass that will never start —
    // `no_model`, `no_runtime`, `deferred` — can stay silent the way the
    // spec demands: it owes the UI no progress stages, not even `queued`.
    // The authoritative recording check still runs *under* the lock below,
    // because a recording may start while this pass waits for its turn.
    let models = match crate::audio_cpp_engine::commands::model_manager() {
        Some(manager) => manager.discover_models().await.unwrap_or_default(),
        // No model manager means no catalogued model at all, exactly like a
        // Whisper/Parakeet session in unit tests.
        None => Vec::new(),
    };
    // Only pay for the runtime probe when a model exists: "no model" outranks
    // "no runtime", and probing loads the library.
    let has_model =
        crate::audio::transcription::diarization_service::select_diarization_model(&models)
            .is_some();
    // The probe runs even when a recording is active on purpose: the spec fixes
    // the priority as no_model → no_runtime → deferred, so with a model
    // installed this is the only way to tell `no_runtime` from `deferred`.
    let runtime_available = if has_model {
        crate::audio_cpp_engine::commands::detect_runtime_available().await
    } else {
        false
    };
    // Checked before the model is loaded: a pass must not compete for memory
    // with an active recording.
    let recording_active = crate::audio::recording_commands::is_recording().await;

    let decision = decide_diarization(&models, runtime_available, recording_active);
    let model = match decision {
        DiarizationDecision::Run { model } => model,
        DiarizationDecision::DoNotRun(status) => {
            info!(
                "Diarization of meeting {} skipped: {:?}",
                meeting_id, status
            );
            let result = SavedMeetingDiarization {
                meeting_id: meeting_id.to_string(),
                status,
                labeled_segments: 0,
                total_segments,
                error: None,
            };
            emit_events(app, &diarization_events(&result, false));
            return Ok(result);
        }
    };

    // The queue stage belongs to a pass that will actually run, so it is
    // announced here — before the lock, while a second pass still holds it.
    // From this beat on, every early return owes a terminal: a surface that
    // saw `queued` is waiting for one.
    emit_pass_progress(app, meeting_id, DiarizationPhase::Queued);

    // One pass at a time. The guard is held across the recording re-check and
    // the model load so the pass cannot interleave with a second caller.
    let _pass = acquire_pass_lock().await;

    // The recording may have started while this pass waited in the queue;
    // under the lock this is still the authoritative answer, because the
    // model load that follows must not compete with an active recording.
    if crate::audio::recording_commands::is_recording().await {
        info!("Diarization of meeting {meeting_id} deferred: a recording started while the pass was queued");
        return Ok(deferred_after_queued(app, meeting_id, total_segments));
    }

    let folder = match meeting.folder_path.as_deref().map(PathBuf::from) {
        Some(folder) => folder,
        None => {
            let result = SavedMeetingDiarization {
                meeting_id: meeting_id.to_string(),
                status: DiarizationStatus::Failed,
                labeled_segments: 0,
                total_segments,
                error: Some("meeting has no recording folder".to_string()),
            };
            emit_events(app, &diarization_events(&result, false));
            return Ok(result);
        }
    };

    // Build the segment list in the same shape the repository stores.
    let mut segments: Vec<crate::api::TranscriptSegment> = meeting
        .transcripts
        .iter()
        .map(|segment| crate::api::TranscriptSegment {
            id: segment.id.clone(),
            text: segment.text.clone(),
            timestamp: segment.timestamp.clone(),
            audio_start_time: segment.audio_start_time,
            audio_end_time: segment.audio_end_time,
            duration: segment.duration,
            speaker: segment.speaker.clone(),
        })
        .collect();

    let outcome = super::diarization_service::diarize_recording_folder_with_model(
        app,
        meeting_id,
        &folder,
        &mut segments,
        &model,
    )
    .await;

    let names_reset;
    if outcome.status == DiarizationStatus::Ran {
        emit_pass_progress(app, meeting_id, DiarizationPhase::LabelsStarted);
        let labeled = segments
            .iter()
            .filter(|segment| segment.speaker.is_some())
            .count();
        match persist_speaker_labels(pool, meeting_id, &segments).await {
            Ok(reset) => names_reset = reset,
            Err(error) => {
                // The pass succeeded but the write did not; report it as a
                // failure without losing the transcript.
                warn!("Failed to persist diarization labels: {error}");
                let result = label_write_failure(meeting_id, total_segments, error);
                emit_events(app, &diarization_events(&result, false));
                return Ok(result);
            }
        }
        // The database is now the authority; bring the meeting's export with
        // it so imports, retranscriptions and live recordings do not leave a
        // `transcripts.json` whose speakers disagree with the transcript.
        rewrite_transcripts_json(&folder, segments).await;
        emit_pass_progress(app, meeting_id, DiarizationPhase::LabelsCommitted);
        info!(
            "Diarized meeting {}: {} of {} transcript segments labeled",
            meeting_id, labeled, total_segments
        );
        let result = SavedMeetingDiarization {
            meeting_id: meeting_id.to_string(),
            status: DiarizationStatus::Ran,
            labeled_segments: labeled,
            total_segments,
            error: None,
        };
        emit_events(app, &diarization_events(&result, names_reset));
        Ok(result)
    } else {
        let result = SavedMeetingDiarization {
            meeting_id: meeting_id.to_string(),
            status: outcome.status,
            labeled_segments: 0,
            total_segments,
            error: outcome.error,
        };
        emit_events(app, &diarization_events(&result, false));
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::common::BatchEngine;
    use crate::audio::transcription::diarization_service::{
        DiarizationStatus, DIARIZATION_PROGRESS_EVENT,
    };
    use std::sync::Mutex;

    fn result(status: DiarizationStatus, labeled: usize, total: usize) -> SavedMeetingDiarization {
        SavedMeetingDiarization {
            meeting_id: "meeting-1".to_string(),
            status,
            labeled_segments: labeled,
            total_segments: total,
            error: None,
        }
    }

    #[tokio::test]
    async fn a_saved_meeting_is_scheduled_regardless_of_the_engine() {
        // The pass used to be gated on the audioCpp engine. The scheduler now
        // takes no engine at all: diarization is a second stage over a finished
        // transcript, and `diarize_saved_meeting` decides on its own whether it
        // can run. Every transcription choice reaches the same pass, and with
        // no catalog in unit tests that pass reports `no_model` and settles —
        // exactly what a Whisper/Parakeet import must see.
        for provider in [Some("whisper"), Some("parakeet"), Some("audioCpp"), None] {
            let engine = BatchEngine::from_provider_name(provider);
            let (pool, app) = meeting_with_two_segments().await;

            let outcome =
                schedule_saved_meeting(app.handle().clone(), pool, "meeting-1".to_string())
                    .await
                    .expect("the scheduled task runs");

            assert_eq!(
                outcome,
                BackgroundPassOutcome::Finished(DiarizationStatus::NoModel),
                "engine: {engine:?}"
            );
        }
    }

    #[test]
    fn a_pass_that_cannot_even_start_becomes_a_log_line_not_a_batch_error() {
        // A missing meeting or a database failure must not turn into a failed
        // import or retranscription: both have already succeeded by the time
        // the background pass runs.
        let outcome = background_pass_outcome(Err("Meeting not found: meeting-9".to_string()));

        assert_eq!(
            outcome,
            BackgroundPassOutcome::CouldNotRun("Meeting not found: meeting-9".to_string())
        );
    }

    #[test]
    fn a_finished_pass_keeps_its_status_for_logging() {
        let outcome = background_pass_outcome(Ok(result(DiarizationStatus::NoModel, 0, 0)));

        assert_eq!(
            outcome,
            BackgroundPassOutcome::Finished(DiarizationStatus::NoModel)
        );
    }

    #[tokio::test]
    async fn a_pass_that_cannot_start_never_propagates_to_the_batch_job() {
        // The import and retranscription call sites await this helper. It must
        // resolve, not reject, so the batch job's `Result` cannot inherit the
        // pass's `Err`.
        let outcome = run_scheduled_diarization("meeting-9", || async {
            Err("Failed to load meeting: database is locked".to_string())
        })
        .await;

        assert_eq!(
            outcome,
            BackgroundPassOutcome::CouldNotRun(
                "Failed to load meeting: database is locked".to_string()
            )
        );
    }

    #[tokio::test]
    async fn a_failed_pass_status_is_reported_without_an_error() {
        let outcome = run_scheduled_diarization("meeting-9", || async {
            Ok(result(DiarizationStatus::Failed, 0, 3))
        })
        .await;

        assert_eq!(
            outcome,
            BackgroundPassOutcome::Finished(DiarizationStatus::Failed)
        );
    }

    #[test]
    fn a_label_write_failure_is_reported_in_band_and_keeps_the_meeting() {
        // The pass ran but the labels could not be committed. It must not
        // become an `Err`: the retranscription/import already succeeded, and
        // the transcript stays intact without labels.
        let failed = label_write_failure(
            "meeting-1",
            7,
            "Failed to commit speaker labels: database is locked".to_string(),
        );

        assert_eq!(failed.status, DiarizationStatus::Failed);
        assert_eq!(failed.total_segments, 7);
        assert_eq!(failed.labeled_segments, 0);
        assert_eq!(
            failed.error.as_deref(),
            Some("Failed to commit speaker labels: database is locked")
        );
        // And a background caller sees a status, never an error it could
        // propagate into the batch job's result.
        assert_eq!(
            background_pass_outcome(Ok(failed)),
            BackgroundPassOutcome::Finished(DiarizationStatus::Failed)
        );
    }

    #[test]
    fn a_ran_pass_with_no_labeled_segments_announces_the_transcript_not_a_failure() {
        let events = diarization_events(&result(DiarizationStatus::Ran, 0, 4), false);

        assert_eq!(
            events,
            vec![DiarizationEvent::TranscriptUpdated {
                meeting_id: "meeting-1".to_string(),
                labeled_segments: 0,
                total_segments: 4,
            }]
        );
    }

    #[test]
    fn a_ran_pass_with_labels_announces_the_transcript() {
        let events = diarization_events(&result(DiarizationStatus::Ran, 3, 4), false);

        assert_eq!(
            events,
            vec![DiarizationEvent::TranscriptUpdated {
                meeting_id: "meeting-1".to_string(),
                labeled_segments: 3,
                total_segments: 4,
            }]
        );
    }

    #[test]
    fn a_failed_pass_announces_unavailability_with_its_reason() {
        let mut failed = result(DiarizationStatus::Failed, 0, 4);
        failed.error = Some("audio is too short".to_string());

        let events = diarization_events(&failed, false);

        assert_eq!(
            events,
            vec![DiarizationEvent::Unavailable {
                meeting_id: "meeting-1".to_string(),
                status: DiarizationStatus::Failed,
                error: Some("audio is too short".to_string()),
            }]
        );
    }

    #[test]
    fn configuration_reasons_stay_silent_because_the_user_did_not_ask() {
        for status in [
            DiarizationStatus::NoModel,
            DiarizationStatus::NoRuntime,
            DiarizationStatus::Deferred,
        ] {
            assert_eq!(
                diarization_events(&result(status, 0, 4), false),
                Vec::new(),
                "status: {status:?}"
            );
        }
    }

    #[test]
    fn a_pass_that_never_announced_queued_defers_in_silence() {
        // The decision-time `deferred` (a recording was already running when
        // the user asked for the pass) never showed a stage, so it owes no
        // terminal either: the silence rule of `diarization_events` still
        // covers it.
        assert_eq!(deferred_after_queue_events("meeting-1", false), Vec::new());
    }

    #[test]
    fn a_queued_pass_that_defers_owes_exactly_one_deferred_terminal() {
        // The race the silence rule cannot cover: the pass announced `queued`
        // and only then found a recording under the lock. A surface watching
        // the stage waits on a terminal, so exactly one must land.
        assert_eq!(
            deferred_after_queue_events("meeting-1", true),
            vec![DiarizationEvent::Unavailable {
                meeting_id: "meeting-1".to_string(),
                status: DiarizationStatus::Deferred,
                error: None,
            }]
        );
    }

    #[tokio::test]
    async fn the_queued_then_deferred_terminal_emits_one_diarization_unavailable() {
        // The emitting half of the race fix, on the mock app: the terminal
        // lands on the existing `diarization-unavailable` channel with the
        // `deferred` status and the `deferred` code, and nothing else. The
        // frontend store already ends a running pass on any non-failed
        // payload of this channel (pinned in
        // `tests/lib/diarization-pass-state.test.ts`).
        let (_pool, app) = meeting_with_two_segments().await;
        let recorded_events = record_events(app.handle());

        let result = deferred_after_queued(app.handle(), "meeting-1", 2);

        assert_eq!(result.status, DiarizationStatus::Deferred);
        assert_eq!(result.total_segments, 2);
        assert_eq!(
            recorded(&recorded_events),
            vec![(
                DIARIZATION_UNAVAILABLE_EVENT.to_string(),
                serde_json::json!({
                    "meeting_id": "meeting-1",
                    "status": "deferred",
                    "reason": null,
                    "code": "deferred",
                })
            )],
            "queued-then-deferred must emit exactly one terminal"
        );
    }

    #[test]
    fn a_deferred_pass_explains_itself_as_a_postponement_not_a_failure() {
        // The under-lock race shows the user why the pass stopped: a
        // recording, not a breakdown. A failure would send them looking for
        // a broken engine.
        assert_eq!(
            unavailable_code(DiarizationStatus::Deferred),
            DIARIZATION_DEFERRED_CODE
        );
        assert_ne!(
            unavailable_code(DiarizationStatus::Deferred),
            unavailable_code(DiarizationStatus::Failed)
        );
    }

    #[test]
    fn a_recount_that_dropped_every_name_is_announced_after_the_refresh() {
        let events = diarization_events(&result(DiarizationStatus::Ran, 2, 4), true);

        assert_eq!(
            events,
            vec![
                DiarizationEvent::TranscriptUpdated {
                    meeting_id: "meeting-1".to_string(),
                    labeled_segments: 2,
                    total_segments: 4,
                },
                DiarizationEvent::SpeakerNamesReset {
                    meeting_id: "meeting-1".to_string(),
                },
            ]
        );
    }

    /// The progress event one pass phase must produce, as JSON, so the payload
    /// contract (`meeting_id`, snake_case `stage`, optional
    /// `progress_percentage`, `message`) is pinned by shape, not by
    /// construction.
    fn progress_json(phase: DiarizationPhase) -> serde_json::Value {
        let event = diarization_progress_event("meeting-1", phase);
        assert_eq!(event.meeting_id, "meeting-1");
        serde_json::to_value(&event).expect("a progress event serializes")
    }

    #[test]
    fn a_queued_phase_announces_the_stage_without_a_percentage() {
        let payload = progress_json(DiarizationPhase::Queued);

        assert_eq!(payload["meeting_id"], "meeting-1");
        assert_eq!(payload["stage"], "queued");
        // "Waiting for the queue" has no countable work: an honest indeterminate
        // stage must omit the key, not invent a number.
        assert!(
            payload.get("progress_percentage").is_none(),
            "queued is indeterminate: {payload}"
        );
        assert!(payload["message"].as_str().is_some_and(|text| !text.is_empty()));
    }

    #[test]
    fn the_model_load_bookends_carry_the_honest_checkpoint_percentage() {
        // The native load gives no intermediate data, so the honest percentage
        // is the two checkpoints around it: just started, and committed.
        let started = progress_json(DiarizationPhase::ModelLoadStarted);
        assert_eq!(started["stage"], "loading_model");
        assert_eq!(started["progress_percentage"], 0);

        let committed = progress_json(DiarizationPhase::ModelLoadCommitted);
        assert_eq!(committed["stage"], "loading_model");
        assert_eq!(committed["progress_percentage"], 100);
    }

    #[test]
    fn decoding_announces_the_stage_without_a_percentage() {
        // The shared decoder gives the pass no callback, so a decoding
        // percentage would be invented.
        let payload = progress_json(DiarizationPhase::Decoding);

        assert_eq!(payload["stage"], "decoding");
        assert!(
            payload.get("progress_percentage").is_none(),
            "decoding is indeterminate: {payload}"
        );
    }

    #[test]
    fn inference_announces_the_stage_without_a_percentage() {
        // The audio.cpp FFI returns nothing until the turn list is ready, so
        // inference is indeterminate by contract.
        let payload = progress_json(DiarizationPhase::Inferring);

        assert_eq!(payload["stage"], "inferring");
        assert!(
            payload.get("progress_percentage").is_none(),
            "inferring is indeterminate: {payload}"
        );
    }

    #[test]
    fn the_label_write_bookends_carry_the_honest_checkpoint_percentage() {
        let started = progress_json(DiarizationPhase::LabelsStarted);
        assert_eq!(started["stage"], "applying_labels");
        assert_eq!(started["progress_percentage"], 0);

        let committed = progress_json(DiarizationPhase::LabelsCommitted);
        assert_eq!(committed["stage"], "applying_labels");
        assert_eq!(committed["progress_percentage"], 100);
    }

    #[test]
    fn every_stage_names_itself_in_snake_case_and_carries_a_message() {
        let stages: Vec<(DiarizationPhase, &str)> = vec![
            (DiarizationPhase::Queued, "queued"),
            (DiarizationPhase::ModelLoadStarted, "loading_model"),
            (DiarizationPhase::Decoding, "decoding"),
            (DiarizationPhase::Inferring, "inferring"),
            (DiarizationPhase::LabelsStarted, "applying_labels"),
        ];
        for (phase, stage) in stages {
            let payload = progress_json(phase);
            assert_eq!(payload["stage"], stage, "phase: {phase:?}");
            assert!(
                payload["message"].as_str().is_some_and(|text| !text.is_empty()),
                "phase {phase:?} must explain itself: {payload}"
            );
        }
    }

    #[test]
    fn missing_model_and_missing_runtime_explain_themselves_differently() {
        assert_eq!(
            unavailable_code(DiarizationStatus::NoModel),
            DIARIZATION_UNAVAILABLE_CODE
        );
        assert_eq!(
            unavailable_code(DiarizationStatus::NoRuntime),
            DIARIZATION_RUNTIME_UNAVAILABLE_CODE
        );
        assert_eq!(
            unavailable_code(DiarizationStatus::Failed),
            DIARIZATION_FAILED_CODE
        );
        assert_ne!(
            unavailable_code(DiarizationStatus::NoModel),
            unavailable_code(DiarizationStatus::NoRuntime)
        );
    }

    async fn migrated_pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("in-memory sqlite");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("migrations apply");
        pool
    }

    async fn seed_meeting(pool: &SqlitePool, meeting_id: &str) {
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(meeting_id)
            .bind("Meeting")
            .bind("2024-01-01T00:00:00Z")
            .bind("2024-01-01T00:00:00Z")
            .execute(pool)
            .await
            .unwrap();
        for (id, speaker, start) in [
            ("t-0", Some("speaker_0"), 0.0_f64),
            ("t-1", Some("speaker_1"), 1.0),
        ] {
            sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(id)
            .bind(meeting_id)
            .bind(format!("Text from {id}"))
            .bind("2024-01-01T00:00:00Z")
            .bind(speaker)
            .bind(start)
            .execute(pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO speakers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
        )
        .bind("person-anna")
        .bind("Anna")
        .bind("2024-01-01T00:00:00Z")
        .bind("2024-01-01T00:00:00Z")
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO meeting_speakers (id, meeting_id, label, speaker_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("binding-1")
        .bind(meeting_id)
        .bind("speaker_0")
        .bind("person-anna")
        .bind("2024-01-01T00:00:00Z")
        .bind("2024-01-01T00:00:00Z")
        .execute(pool)
        .await
        .unwrap();
    }

    fn segment(id: &str, speaker: Option<&str>) -> crate::api::TranscriptSegment {
        crate::api::TranscriptSegment {
            id: id.to_string(),
            text: "hello".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            audio_start_time: Some(0.0),
            audio_end_time: Some(1.0),
            duration: Some(1.0),
            speaker: speaker.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn labels_are_written_wholesale_and_the_name_recount_joins_the_same_transaction() {
        let pool = migrated_pool().await;
        seed_meeting(&pool, "meeting-1").await;

        // The pass renumbered the voices: `speaker_0` is gone, `speaker_2` is
        // new. The name bound to the vanished label must not survive.
        let names_reset = persist_speaker_labels(
            &pool,
            "meeting-1",
            &[segment("t-0", Some("speaker_2")), segment("t-1", None)],
        )
        .await
        .expect("labels persist");

        assert!(names_reset, "the old binding should be reported as reset");
        let labels: Vec<(Option<String>,)> =
            sqlx::query_as("SELECT speaker FROM transcripts WHERE meeting_id = ? ORDER BY id")
                .bind("meeting-1")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(
            labels,
            vec![(Some("speaker_2".to_string()),), (None,)],
            "labels are replaced, not merged"
        );
        let bindings: Vec<(String,)> =
            sqlx::query_as("SELECT label FROM meeting_speakers WHERE meeting_id = ?")
                .bind("meeting-1")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(bindings.is_empty(), "binding: {bindings:?}");
    }

    #[tokio::test]
    async fn a_kept_label_keeps_its_name_and_is_not_reported_as_a_reset() {
        let pool = migrated_pool().await;
        seed_meeting(&pool, "meeting-1").await;

        let names_reset = persist_speaker_labels(
            &pool,
            "meeting-1",
            &[segment("t-0", Some("speaker_0")), segment("t-1", Some("speaker_1"))],
        )
        .await
        .expect("labels persist");

        assert!(!names_reset);
        let bindings: Vec<(String,)> =
            sqlx::query_as("SELECT label FROM meeting_speakers WHERE meeting_id = ?")
                .bind("meeting-1")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(bindings, vec![("speaker_0".to_string(),)]);
    }

    /// Points a seeded meeting at a recording folder, the way every saved
    /// meeting is laid out on disk.
    async fn set_folder_path(pool: &SqlitePool, meeting_id: &str, folder: &std::path::Path) {
        sqlx::query("UPDATE meetings SET folder_path = ? WHERE id = ?")
            .bind(folder.to_string_lossy().to_string())
            .bind(meeting_id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn read_written_speakers(folder: &std::path::Path) -> Vec<serde_json::Value> {
        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(folder.join("transcripts.json"))
                .expect("transcripts.json exists"),
        )
        .expect("transcripts.json is valid json");
        written["segments"]
            .as_array()
            .expect("segments array")
            .iter()
            .map(|segment| segment["speaker"].clone())
            .collect()
    }

    #[tokio::test]
    async fn rewritten_transcripts_json_carries_the_new_speaker_labels() {
        // Both batch paths write `transcripts.json` before the pass and then
        // store labels only in the database. The shared rewrite must close
        // that gap: the file a user exports has to agree with the transcript.
        let pool = migrated_pool().await;
        let folder = tempfile::tempdir().unwrap();
        seed_meeting(&pool, "meeting-1").await;
        set_folder_path(&pool, "meeting-1", folder.path()).await;

        let labeled = vec![
            segment("t-0", Some("speaker_2")),
            segment("t-1", Some("speaker_2")),
        ];

        persist_speaker_labels(&pool, "meeting-1", &labeled)
            .await
            .expect("labels persist");
        rewrite_transcripts_json(folder.path(), labeled).await;

        let file_speakers = read_written_speakers(folder.path());
        assert_eq!(
            file_speakers,
            vec![
                serde_json::json!("speaker_2"),
                serde_json::json!("speaker_2")
            ],
            "the file must carry the labels the pass produced"
        );

        let db_speakers: Vec<(Option<String>,)> =
            sqlx::query_as("SELECT speaker FROM transcripts WHERE meeting_id = ? ORDER BY id")
                .bind("meeting-1")
                .fetch_all(&pool)
                .await
                .unwrap();
        let db_speakers: Vec<serde_json::Value> = db_speakers
            .into_iter()
            .map(|(speaker,)| serde_json::json!(speaker))
            .collect();
        assert_eq!(
            file_speakers, db_speakers,
            "the export and the database must not diverge"
        );
    }

    /// A saved meeting with two labelled transcripts, addressed by the mock
    /// app the same way the manual command and the batch jobs address it.
    async fn meeting_with_two_segments() -> (SqlitePool, tauri::App<tauri::test::MockRuntime>) {
        let pool = migrated_pool().await;
        seed_meeting(&pool, "meeting-1").await;
        (pool, tauri::test::mock_app())
    }

    #[tokio::test]
    async fn a_skipped_pass_still_reports_the_meetings_segment_count() {
        // The speakers panel shows "N of M segments" from the manual result, so
        // a `no_model` answer must carry the real total instead of zero: the
        // meeting is read before the decision, and the decision only guards the
        // model load.
        let (pool, app) = meeting_with_two_segments().await;

        let result = diarize_saved_meeting(app.handle(), &pool, "meeting-1")
            .await
            .expect("a missing model is a status, not an error");

        assert_eq!(result.status, DiarizationStatus::NoModel);
        assert_eq!(result.labeled_segments, 0);
        assert_eq!(result.total_segments, 2);
    }

    /// Records every emit of the known pass-channel events — the three
    /// terminals plus `diarization-progress` — the way the frontend listeners
    /// see them. The mock runtime's `Event` carries no name, so each contract
    /// event gets its own listener; an emit under any other name simply does
    /// not reach them. Watching the progress channel here is what pins the
    /// silence rule: a configuration reason must produce no progress stages.
    struct EmittedEvents {
        /// `(event name, payload)` in arrival order.
        events: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
        _ids: Vec<tauri::EventId>,
    }

    fn record_events<R: Runtime>(app: &AppHandle<R>) -> EmittedEvents {
        let events: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let mut ids = Vec::new();
        for name in [
            TRANSCRIPT_UPDATED_EVENT,
            DIARIZATION_UNAVAILABLE_EVENT,
            SPEAKER_NAMES_RESET_EVENT,
            DIARIZATION_PROGRESS_EVENT,
        ] {
            let collected = events.clone();
            let name = name.to_string();
            ids.push(tauri::Listener::listen_any(app, name.clone(), move |event| {
                let payload =
                    serde_json::from_str(event.payload()).expect("terminal events carry json");
                collected.lock().unwrap().push((name.clone(), payload));
            }));
        }
        EmittedEvents {
            events,
            _ids: ids,
        }
    }

    fn recorded(events: &EmittedEvents) -> Vec<(String, serde_json::Value)> {
        events.events.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn the_pass_emits_only_the_terminal_events_it_owed() {
        // The emitter now reaches the whole pass chain (service, model load,
        // inference), so a skipped pass must still announce exactly the
        // terminal events it always did and nothing else: no new event names,
        // no changed payloads.
        let (pool, app) = meeting_with_two_segments().await;
        let recorded_events = record_events(app.handle());

        let result = diarize_saved_meeting(app.handle(), &pool, "meeting-1")
            .await
            .expect("a missing model is a status, not an error");
        assert_eq!(result.status, DiarizationStatus::NoModel);

        let emitted = recorded(&recorded_events);
        assert!(
            emitted.is_empty(),
            "a no_model pass stays silent, got: {emitted:?}"
        );
    }

    #[tokio::test]
    async fn a_failed_pass_emits_only_diarization_unavailable_with_its_payload() {
        // Same pinning for the announcing branch: the emitter threading must
        // not add or rename events, and the payload keys stay exactly the
        // contract the frontend mirrors.
        let (pool, app) = meeting_with_two_segments().await;
        let recorded_events = record_events(app.handle());

        let result = diarize_saved_meeting(app.handle(), &pool, "meeting-1")
            .await
            .expect("a skipped pass is a status, not an error");

        let emitted = recorded(&recorded_events);
        // With no catalogued model the pass stays a silent configuration
        // reason; the assertion pins the silence rule, and the payload shape
        // below pins the announcing rule for the same code path.
        assert_eq!(result.status, DiarizationStatus::NoModel);
        assert!(emitted.is_empty(), "got: {emitted:?}");

        // The announcing path itself: a `failed` result must produce exactly
        // one `diarization-unavailable` with the mirrored payload.
        let failed = SavedMeetingDiarization {
            meeting_id: "meeting-1".to_string(),
            status: DiarizationStatus::Failed,
            labeled_segments: 0,
            total_segments: 2,
            error: Some("meeting has no recording folder".to_string()),
        };
        emit_events(app.handle(), &diarization_events(&failed, false));

        let emitted = recorded(&recorded_events);
        assert_eq!(
            emitted,
            vec![(
                DIARIZATION_UNAVAILABLE_EVENT.to_string(),
                serde_json::json!({
                    "meeting_id": "meeting-1",
                    "status": "failed",
                    "reason": "meeting has no recording folder",
                    "code": "failed",
                })
            )],
            "the emitter threading must not change the terminal events"
        );
    }

    #[tokio::test]
    async fn a_pass_for_an_unknown_meeting_is_an_error_even_without_a_model() {
        // Reading the meeting before the decision keeps the id honest: a
        // request for a meeting that does not exist must never come back as a
        // calm "no model" result. The repository reports the missing row as a
        // database error, so only the shape of the answer is asserted here.
        let (pool, app) = meeting_with_two_segments().await;

        let result = diarize_saved_meeting(app.handle(), &pool, "meeting-gone").await;

        assert!(result.is_err(), "result: {result:?}");
    }

    #[tokio::test]
    async fn a_missing_folder_only_logs_instead_of_inverting_the_result() {
        // Rewriting the export is best effort: the labels are already in the
        // database, so a folder that cannot be written keeps the pass's
        // `ran` status and only warns.
        let folder = tempfile::tempdir().unwrap();
        let gone = folder.path().join("deleted");
        rewrite_transcripts_json(&gone, vec![segment("t-0", Some("speaker_2"))]).await;

        assert!(!gone.join("transcripts.json").exists());
    }
}
