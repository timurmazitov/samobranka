use crate::api::TranscriptSegment;
use anyhow::Result;
use log::{debug, info};
use once_cell::sync::Lazy;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

static ENGINE_LIFECYCLE_LOCK: Lazy<Arc<AsyncMutex<()>>> =
    Lazy::new(|| Arc::new(AsyncMutex::new(())));

pub(crate) async fn acquire_engine_lifecycle_lock() -> OwnedMutexGuard<()> {
    ENGINE_LIFECYCLE_LOCK.clone().lock_owned().await
}

/// Which transcription engine a batch job (import or retranscription) runs.
/// Batch jobs name the provider explicitly, exactly like the live pipeline
/// resolves it from the transcript configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchEngine {
    /// Runs transcribe.cpp offline ASR over the batch segments (retranscription
    /// and import build the provider with the exact requested model).
    TranscribeCpp,
}

impl BatchEngine {
    /// Map the provider name sent by the frontend to an engine.
    ///
    /// Anything unrecognized (including `None`) runs on transcribe.cpp, the
    /// only local engine this build ships (the soft migration normalizes
    /// saved providers the same way).
    pub(crate) fn from_provider_name(_provider: Option<&str>) -> Self {
        // transcribe.cpp is the only batch transcription engine this build
        // ships; every saved or requested provider resolves to it (the
        // settings soft migration normalizes saved providers the same way).
        Self::TranscribeCpp
    }
}

/// Unload the transcription engine after a batch job (import or retranscription).
/// Skips unloading if a live recording is currently in progress, since recording
/// uses the same global engine instances.
pub(crate) async fn unload_engine_after_batch(engine: BatchEngine) {
    // Lock first, then read the recording state: recording start takes the
    // same lock before setting its flag, so a recording that started while
    // this batch was finishing still skips the unload (the check must not
    // happen before the guard exists).
    let engine_lifecycle_guard = acquire_engine_lifecycle_lock().await;
    let recording_active = crate::audio::recording_commands::is_recording().await;
    unload_engine_after_batch_locked(engine, recording_active, engine_lifecycle_guard).await;
}

/// The recording check is a parameter (together with the already-held
/// lifecycle guard) so tests can pin both halves of the lifecycle rule —
/// unload when idle, never unload under an active recording — without
/// driving the recording globals.
async fn unload_engine_after_batch_locked(
    engine: BatchEngine,
    recording_active: bool,
    _engine_lifecycle_guard: OwnedMutexGuard<()>,
) {
    if recording_active {
        log::info!("Skipping model unload after batch: recording in progress");
        return;
    }

    match engine {
        BatchEngine::TranscribeCpp => {
            // Releases the model and its session thread. The session-thread
            // join runs on a blocking thread inside
            // (async callers must not wait out in-flight native inference
            // on the runtime).
            crate::transcribe_cpp_engine::transcription::unload_provider().await;
        }
    }
}

/// Find the audio file inside a meeting folder.
///
/// Tries the known recording names first (recording output and imports), then
/// scans for any file with a supported audio extension. Shared by the
/// retranscription and diarization paths so both agree on what counts as the
/// recording.
pub(crate) fn find_audio_file(folder: &Path) -> Option<std::path::PathBuf> {
    const CANDIDATES: [&str; 10] = [
        "audio.mp4",
        "audio.m4a",
        "audio.wav",
        "audio.mp3",
        "audio.flac",
        "audio.ogg",
        "recording.mp4",
        "audio.mkv",
        "audio.webm",
        "audio.wma",
    ];

    for name in CANDIDATES {
        let path = folder.join(name);
        if path.exists() {
            return Some(path);
        }
    }

    std::fs::read_dir(folder).ok()?.flatten().find_map(|entry| {
        let path = entry.path();
        let extension = path.extension()?.to_string_lossy().to_lowercase();
        crate::audio::constants::AUDIO_EXTENSIONS
            .contains(&extension.as_str())
            .then_some(path)
    })
}

/// Create transcript segments from transcription results.
/// Each tuple is (text, start_ms, end_ms) from VAD timestamps.
pub(crate) fn create_transcript_segments(
    transcripts: &[(String, f64, f64)],
) -> Vec<TranscriptSegment> {
    transcripts
        .iter()
        .map(|(text, start_ms, end_ms)| {
            let start_seconds = start_ms / 1000.0;
            let end_seconds = end_ms / 1000.0;
            let duration = end_seconds - start_seconds;

            TranscriptSegment {
                id: format!("transcript-{}", Uuid::new_v4()),
                text: text.trim().to_string(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                audio_start_time: Some(start_seconds),
                audio_end_time: Some(end_seconds),
                duration: Some(duration),
                speaker: None,
            }
        })
        .collect()
}

/// Write transcripts.json to a meeting folder (atomic write with temp file)
pub(crate) fn write_transcripts_json(folder: &Path, segments: &[TranscriptSegment]) -> Result<()> {
    let transcript_path = folder.join("transcripts.json");
    let temp_path = folder.join(".transcripts.json.tmp");

    let json = serde_json::json!({
        "version": "1.0",
        "last_updated": chrono::Utc::now().to_rfc3339(),
        "total_segments": segments.len(),
        "segments": segments.iter().enumerate().map(|(i, s)| {
            serde_json::json!({
                "id": s.id,
                "text": s.text,
                "timestamp": s.timestamp,
                "audio_start_time": s.audio_start_time,
                "audio_end_time": s.audio_end_time,
                "duration": s.duration,
                "speaker": s.speaker,
                "sequence_id": i
            })
        }).collect::<Vec<_>>()
    });

    let json_string = serde_json::to_string_pretty(&json)?;
    std::fs::write(&temp_path, &json_string)?;
    std::fs::rename(&temp_path, &transcript_path)?;

    info!(
        "Wrote transcripts.json with {} segments to {}",
        segments.len(),
        transcript_path.display()
    );
    Ok(())
}

/// Split a long speech segment at the lowest-energy (silence) point near the target size.
///
/// Scans for 100ms windows with minimal RMS energy within +/-3 seconds of each target
/// split point. If no clear silence is found, falls back to a 1-second overlap split
/// to avoid cutting words at boundaries.
///
/// `pub` (not just crate-visible) so the #[ignore]d live batch smoke test can
/// mirror the exact splitting the retranscription/import paths perform.
pub fn split_segment_at_silence(
    segment: &crate::audio::vad::SpeechSegment,
    max_samples: usize,
) -> Vec<crate::audio::vad::SpeechSegment> {
    const SAMPLE_RATE: usize = 16000;
    // 100ms window for energy measurement (1600 samples at 16kHz)
    const ENERGY_WINDOW: usize = SAMPLE_RATE / 10;
    // Search +/-3 seconds around the target split point
    const SEARCH_RADIUS: usize = SAMPLE_RATE * 3;
    // RMS threshold below which we consider a window "silent"
    const SILENCE_RMS_THRESHOLD: f32 = 0.02;
    // Overlap to use when no silence boundary is found (1 second)
    const FALLBACK_OVERLAP: usize = SAMPLE_RATE;

    let total = segment.samples.len();
    if total <= max_samples {
        return vec![segment.clone()];
    }

    let ms_per_sample =
        (segment.end_timestamp_ms - segment.start_timestamp_ms) / segment.samples.len() as f64;
    let mut result = Vec::new();
    let mut pos = 0usize;

    while pos < total {
        let remaining = total - pos;
        if remaining <= max_samples {
            // Last chunk - take everything remaining
            let chunk_samples = segment.samples[pos..].to_vec();
            let chunk_start_ms = segment.start_timestamp_ms + (pos as f64 * ms_per_sample);
            let chunk_end_ms = segment.end_timestamp_ms;
            result.push(crate::audio::vad::SpeechSegment {
                samples: chunk_samples,
                start_timestamp_ms: chunk_start_ms,
                end_timestamp_ms: chunk_end_ms,
                confidence: segment.confidence,
            });
            break;
        }

        // Target split point
        let target = pos + max_samples;

        // Search window: [target - SEARCH_RADIUS, target + SEARCH_RADIUS]
        let search_start = target.saturating_sub(SEARCH_RADIUS).max(pos + SAMPLE_RATE);
        let search_end = (target + SEARCH_RADIUS).min(total.saturating_sub(ENERGY_WINDOW));

        // Find the lowest-energy 100ms window in the search range
        let mut best_split = target.min(total); // fallback: exact target
        let mut best_rms = f32::MAX;

        if search_start + ENERGY_WINDOW <= search_end {
            let mut idx = search_start;
            while idx + ENERGY_WINDOW <= search_end {
                let window = &segment.samples[idx..idx + ENERGY_WINDOW];
                let rms = (window.iter().map(|s| s * s).sum::<f32>() / ENERGY_WINDOW as f32).sqrt();
                if rms < best_rms {
                    best_rms = rms;
                    best_split = idx + ENERGY_WINDOW / 2; // split at center of quiet window
                }
                // Step by 10ms (160 samples) for efficiency
                idx += SAMPLE_RATE / 100;
            }
        }

        let split_at = best_split;
        if best_rms <= SILENCE_RMS_THRESHOLD {
            debug!(
                "Splitting at silence boundary: sample {} (RMS={:.4})",
                split_at, best_rms
            );
        } else {
            debug!(
                "No silence found near target (best RMS={:.4}), splitting with overlap at sample {}",
                best_rms, split_at
            );
        }

        // Determine the actual end of this chunk (with overlap if no silence)
        let chunk_end = if best_rms > SILENCE_RMS_THRESHOLD {
            (split_at + FALLBACK_OVERLAP).min(total)
        } else {
            split_at
        };

        let chunk_samples = segment.samples[pos..chunk_end].to_vec();
        let chunk_start_ms = segment.start_timestamp_ms + (pos as f64 * ms_per_sample);
        let chunk_end_ms = segment.start_timestamp_ms + (chunk_end as f64 * ms_per_sample);

        result.push(crate::audio::vad::SpeechSegment {
            samples: chunk_samples,
            start_timestamp_ms: chunk_start_ms,
            end_timestamp_ms: chunk_end_ms,
            confidence: segment.confidence,
        });

        // Advance position to where the current chunk actually ends
        // to avoid transcribing the overlap region twice
        pos = chunk_end;
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_engine_selection_recognizes_transcribe_cpp() {
        assert_eq!(
            BatchEngine::from_provider_name(Some("transcribeCpp")),
            BatchEngine::TranscribeCpp
        );
    }

    #[test]
    fn batch_engine_selection_defaults_to_transcribe_cpp() {
        // "whisper", "parakeet" and "audioCpp" are removed transcription
        // providers: with those paths gone they are just unrecognized names
        // and land on transcribe.cpp (the settings soft migration normalizes
        // saved providers the same way).
        for provider in [
            None,
            Some("whisper"),
            Some("localWhisper"),
            Some("parakeet"),
            Some("audioCpp"),
            Some("deepgram"),
            Some(""),
        ] {
            assert_eq!(
                BatchEngine::from_provider_name(provider),
                BatchEngine::TranscribeCpp,
                "provider: {provider:?}"
            );
        }
    }

    #[test]
    fn find_audio_file_prefers_the_known_recording_names() {
        let dir = tempfile::tempdir().unwrap();

        assert!(find_audio_file(dir.path()).is_none());

        std::fs::write(dir.path().join("audio.wav"), b"fake").unwrap();
        let found = find_audio_file(dir.path()).expect("audio.wav is a known name");
        assert_eq!(found.file_name().unwrap(), "audio.wav");

        // Imports can land as .wav/.m4a/.flac too; the candidate order wins.
        std::fs::write(dir.path().join("audio.m4a"), b"fake").unwrap();
        std::fs::write(dir.path().join("audio.mp4"), b"fake").unwrap();
        let found = find_audio_file(dir.path()).unwrap();
        assert_eq!(found.file_name().unwrap(), "audio.mp4");
    }

    #[test]
    fn find_audio_file_falls_back_to_any_audio_extension() {
        let dir = tempfile::tempdir().unwrap();

        std::fs::write(dir.path().join("my_recording.flac"), b"fake").unwrap();
        std::fs::write(dir.path().join("notes.txt"), b"text").unwrap();

        let found = find_audio_file(dir.path()).expect("fallback scan finds the audio file");
        assert_eq!(found.file_name().unwrap(), "my_recording.flac");
    }

    #[test]
    fn find_audio_file_reports_absence_instead_of_guessing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(find_audio_file(dir.path()).is_none());
        assert!(find_audio_file(Path::new("/nonexistent/path/12345")).is_none());
    }

    #[test]
    fn transcripts_json_keeps_the_diarization_speaker_label() {
        let dir = tempfile::tempdir().unwrap();
        let segments = vec![
            TranscriptSegment {
                id: "t1".to_string(),
                text: "hello".to_string(),
                timestamp: "2026-01-01T00:00:00Z".to_string(),
                audio_start_time: Some(0.0),
                audio_end_time: Some(1.0),
                duration: Some(1.0),
                speaker: Some("speaker_1".to_string()),
            },
            TranscriptSegment {
                id: "t2".to_string(),
                text: "world".to_string(),
                timestamp: "2026-01-01T00:00:01Z".to_string(),
                audio_start_time: Some(1.0),
                audio_end_time: Some(2.0),
                duration: Some(1.0),
                speaker: None,
            },
        ];

        write_transcripts_json(dir.path(), &segments).expect("transcript file is written");

        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("transcripts.json")).unwrap(),
        )
        .unwrap();
        // The export must carry the label the database already has, so an
        // exported meeting does not lose who said what.
        assert_eq!(written["segments"][0]["speaker"], "speaker_1");
        assert_eq!(written["segments"][1]["speaker"], serde_json::Value::Null);
    }

    // --- Batch engine unload lifecycle (ticket 07) -------------------------
    //
    // The TranscribeCpp unload arm must release the model and its session
    // thread when the batch is done, and must never do that while a recording
    // is active (recording reuses the same global provider). The recording
    // check is injected through the private locked helper so both halves of
    // the rule are pinned without driving the recording globals; the public
    // wrapper reads the same state from recording_commands.

    use crate::audio::transcription::provider::TranscriptionProvider;
    use crate::audio::transcription::transcribe_cpp_provider::TranscribeCppProvider;
    use crate::transcribe_cpp_engine::engine::{
        TranscribeCppEngine, TranscribeCppModel, TranscriptionOutput,
    };
    use crate::transcribe_cpp_engine::error::TranscribeCppError;

    /// The transcribe.cpp provider global is process-wide; these tests own it
    /// one at a time.
    static PROVIDER_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct IdleModel;

    impl TranscribeCppModel for IdleModel {
        fn backend(&self) -> String {
            "cpu".to_string()
        }

        fn transcribe_asr(
            &mut self,
            _audio: &[f32],
            _sample_rate: i32,
            _language: Option<&str>,
        ) -> Result<TranscriptionOutput, TranscribeCppError> {
            Ok(TranscriptionOutput {
                backend: "cpu".into(),
                text: "текст".to_string(),
                segments: Vec::new(),
                detected_language: None,
            })
        }
    }

    struct IdleEngine;

    impl TranscribeCppEngine for IdleEngine {
        fn load_model(
            &self,
            _path: &std::path::Path,
        ) -> Result<Box<dyn TranscribeCppModel>, TranscribeCppError> {
            Ok(Box::new(IdleModel))
        }
    }

    async fn loaded_transcribe_cpp_provider() -> std::sync::Arc<TranscribeCppProvider> {
        crate::transcribe_cpp_engine::transcription::set_provider(
            TranscribeCppProvider::load(
                std::sync::Arc::new(IdleEngine),
                "parakeet-ultra-Q8_0",
                std::path::PathBuf::from("/models/m.gguf"),
            )
            .await
            .expect("fake model loads"),
            crate::transcribe_cpp_engine::backend::ComputeMode::Auto,
        )
    }

    /// The global provider handle the unload arm reads (named so a test
    /// variable called `provider` cannot shadow it).
    fn global_provider() -> Option<std::sync::Arc<TranscribeCppProvider>> {
        crate::transcribe_cpp_engine::transcription::provider()
    }

    #[tokio::test]
    async fn a_finished_batch_unloads_the_transcribe_cpp_provider_and_its_thread() {
        let _serial = PROVIDER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        crate::transcribe_cpp_engine::transcription::unload_provider().await;

        let provider = loaded_transcribe_cpp_provider().await;
        assert!(global_provider().is_some(), "the batch ran with a loaded model");
        provider
            .transcribe(vec![0.1; 1600], None)
            .await
            .expect("segment transcribes");

        // Unload joins the session thread: completing within the timeout
        // proves the thread ended (a leaked thread would hang the join).
        let guard = ENGINE_LIFECYCLE_LOCK.clone().lock_owned().await;
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            unload_engine_after_batch_locked(BatchEngine::TranscribeCpp, false, guard),
        )
        .await
        .expect("the unload joins the session thread and must not hang");

        assert!(
            global_provider().is_none(),
            "the batch must drop the global provider"
        );
        assert!(
            !provider.is_model_loaded().await,
            "the model and its session thread are released"
        );
    }

    #[tokio::test]
    async fn an_active_recording_keeps_the_transcribe_cpp_provider_loaded() {
        let _serial = PROVIDER_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        crate::transcribe_cpp_engine::transcription::unload_provider().await;

        let provider = loaded_transcribe_cpp_provider().await;

        let guard = ENGINE_LIFECYCLE_LOCK.clone().lock_owned().await;
        unload_engine_after_batch_locked(BatchEngine::TranscribeCpp, true, guard).await;

        assert!(
            global_provider().is_some(),
            "a batch ending during a recording must not unload the model recording is using"
        );
        assert!(provider.is_model_loaded().await);

        // Cleanup: the idle path does unload, proving the skip was the
        // recording flag and not a broken unload arm.
        crate::transcribe_cpp_engine::transcription::unload_provider().await;
        assert!(global_provider().is_none());
    }

    #[test]
    fn batch_event_payloads_share_the_engine_agnostic_shape() {
        // The retranscription/import progress, result and error events carry
        // the same fields for every engine (the frontend listens with one
        // handler per event), so a transcribeCpp batch needs no new event
        // contract. Serializing the real payload structs pins that.
        let progress = serde_json::to_value(super::super::retranscription::RetranscriptionProgress {
            meeting_id: "m-1".to_string(),
            stage: "transcribing".to_string(),
            progress_percentage: 42,
            message: "Transcribing segment 1 of 2 (1.0s)...".to_string(),
            code: None,
            params: None,
        })
        .unwrap();
        assert_eq!(
            progress["meeting_id"], "m-1",
            "retranscription progress keeps the audio.cpp payload keys"
        );
        assert_eq!(progress["stage"], "transcribing");
        assert_eq!(progress["progress_percentage"], 42);

        let failure =
            serde_json::to_value(super::super::retranscription::RetranscriptionError {
                meeting_id: "m-1".to_string(),
                error: "transcribeCpp transcription failed on segment 0: boom".to_string(),
            })
            .unwrap();
        assert_eq!(failure["meeting_id"], "m-1");
        assert!(failure["error"].as_str().unwrap().contains("transcribeCpp"));

        let import_progress = serde_json::to_value(super::super::import::ImportProgress {
            stage: "transcribing".to_string(),
            progress_percentage: 42,
            message: "Transcribing segment 1 of 2 (1.0s)...".to_string(),
            code: None,
            params: None,
        })
        .unwrap();
        assert_eq!(import_progress["stage"], "transcribing");
        assert_eq!(import_progress["progress_percentage"], 42);

        let import_failure = serde_json::to_value(super::super::import::ImportError {
            error: "Transcribe.cpp model 'x' is not available.".to_string(),
        })
        .unwrap();
        assert!(import_failure["error"].as_str().unwrap().contains("not available"));
    }

    #[tokio::test]
    async fn test_engine_lifecycle_lock_serializes_acquirers() {
        let guard = acquire_engine_lifecycle_lock().await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (acquired_tx, mut acquired_rx) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async {
            started_tx.send(()).unwrap();
            let _guard = acquire_engine_lifecycle_lock().await;
            acquired_tx.send(()).unwrap();
        });

        started_rx.await.unwrap();
        assert!(acquired_rx.try_recv().is_err());
        drop(guard);

        acquired_rx.await.unwrap();
        waiter.await.unwrap();
    }
}
