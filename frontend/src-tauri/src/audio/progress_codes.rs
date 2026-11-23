// audio/progress_codes.rs
//
// The progress vocabulary the two batch paths (import and retranscription)
// share (native-i18n spec D7). Modelled on `src/error_codes.rs`: one module
// owns the stable `code` values that travel on `import-progress` /
// `retranscription-progress` payloads, plus the interpolated prose/params
// shapes both paths emit verbatim, so the two files cannot drift apart and
// one frontend catalog rename lands in one place.
//
// Rules (same as `error_codes.rs`):
// - Codes are stable identifiers, never the English text; renaming a code is
//   a breaking change for older frontend translations and vice versa.
// - The English prose stays in every payload as the diagnostic fallback;
//   these builders exist so the fallback prose and the codes are written
//   exactly once across the two paths.
// - The frontend pinning test (`tests/lib/native-progress-i18n.test.ts`)
//   extracts every `const CODE_*: &str = "value";` from this file and the
//   two path files by regex and requires each code to resolve to a non-empty
//   catalog key in BOTH locales. That is why the shared constants keep the
//   `CODE_` prefix here: renaming them without the prefix silently shrinks
//   the pinned set. Codes defined here belong to BOTH paths' namespaces
//   (`importAudio.progress.*` and `retranscribe.progress.*`).

use serde_json::{json, Value};

use super::decoder::{DecodeProgress, ProgressCallback};

/// The English fallback prose both bars send at the decoding milestone. It
/// stays on the payload as the diagnostic fallback (spec D7), so it is pinned
/// here once and shared rather than typed twice.
pub(crate) const MESSAGE_DECODING_FILE: &str = "Decoding audio file...";
/// The English fallback prose of the resample/conversion milestone.
pub(crate) const MESSAGE_CONVERTING_FORMAT: &str = "Converting audio format...";
/// The English fallback prose of the VAD start milestone.
pub(crate) const MESSAGE_DETECTING_SEGMENTS: &str = "Detecting speech segments...";
/// The English fallback prose of the transcription-band start milestone.
pub(crate) const MESSAGE_LOADING_ENGINE: &str = "Loading transcription engine...";
/// The English fallback prose of the file-write milestone.
pub(crate) const MESSAGE_WRITING_FILES: &str = "Writing transcript files...";

/// "Decoding audio file..." — the decoding milestone of both bars.
pub(crate) const CODE_DECODING_FILE: &str = "decoding_file";
/// "Converting audio format..." — the resample/conversion milestone.
pub(crate) const CODE_CONVERTING_FORMAT: &str = "converting_format";
/// "Detecting speech segments..." — the VAD start milestone.
pub(crate) const CODE_DETECTING_SEGMENTS: &str = "detecting_segments";
/// The live VAD line, with `percent`/`found` in `params`.
pub(crate) const CODE_DETECTING_SEGMENTS_PROGRESS: &str = "detecting_segments_progress";
/// "Loading transcription engine..." — the start of the transcription band.
pub(crate) const CODE_LOADING_ENGINE: &str = "loading_engine";
/// The per-segment line, with `current`/`total`/`duration_sec` in `params`.
pub(crate) const CODE_TRANSCRIBING_SEGMENT: &str = "transcribing_segment";
/// "Writing transcript files..." — the file-write milestone.
pub(crate) const CODE_WRITING_FILES: &str = "writing_files";
/// The terminal; on the frontend it reuses the existing
/// `importAudio.stages.complete` / `retranscribe.stages.complete` key rather
/// than a progress twin.
pub(crate) const CODE_COMPLETE: &str = "complete";

/// The English fallback prose of the live VAD line. `params` is the
/// interpolation for the frontend key; both stay in lockstep because the
/// frontend renders the key and the prose is the diagnostic fallback only.
pub(crate) fn detecting_segments_message(percent: u32, found: usize) -> String {
    format!("Detecting speech segments... {percent}% ({found} found)")
}

/// The `params` for [`CODE_DETECTING_SEGMENTS_PROGRESS`].
pub(crate) fn detecting_segments_params(percent: u32, found: usize) -> Value {
    json!({ "percent": percent, "found": found })
}

/// The English fallback prose of the per-segment line. `index` is 0-based;
/// the sentence numbers segments from 1.
pub(crate) fn transcribing_segment_message(index: usize, total: usize, duration_sec: f64) -> String {
    format!(
        "Transcribing segment {} of {} ({:.1}s)...",
        index + 1,
        total,
        duration_sec
    )
}

/// The `params` for [`CODE_TRANSCRIBING_SEGMENT`].
pub(crate) fn transcribing_segment_params(
    index: usize,
    total: usize,
    duration_sec: f64,
) -> Value {
    json!({
        "current": index + 1,
        "total": total,
        "duration_sec": duration_sec,
    })
}

/// Maps a raw 0-100 report of one 5-point band (decode, resample, VAD) into
/// the bar's overall percentage, exactly as both paths have always computed
/// it: `base + (percent * 0.05)` truncated to an integer.
pub(crate) fn band_percent(base: u32, raw_percent: u32) -> u32 {
    base + ((raw_percent as f32 * 0.05) as u32)
}

/// The callback shape both batch paths use to forward a decoder report
/// under their own bar: the decoder's raw 0-100 is mapped into the 5-point
/// band starting at `base`, and the coded message/code/params travel through
/// unchanged (the decoder owns that sentence). `emit` is the path's own
/// `emit_progress` half with the bar's event name, stage, and (for the
/// retranscription bar) meeting id already captured — the two paths' payload
/// builders differ only there.
pub(crate) fn forward_decode_progress(
    base: u32,
    emit: impl Fn(u32, &str, &str, Option<Value>) + Send + Sync + 'static,
) -> ProgressCallback {
    Box::new(move |progress: &DecodeProgress| {
        emit(
            band_percent(base, progress.percent),
            &progress.message,
            progress.code,
            progress.params.clone(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The prose the pre-i18n payload carried is byte-identical to what the
    /// builders produce — the English message stays the diagnostic fallback
    /// (spec D7), so an edit here is an emitter wire change.
    #[test]
    fn detecting_segments_prose_and_params_match_the_emitted_payload() {
        assert_eq!(
            detecting_segments_message(40, 3),
            "Detecting speech segments... 40% (3 found)"
        );
        assert_eq!(
            detecting_segments_params(40, 3),
            json!({ "percent": 40, "found": 3 })
        );
    }

    #[test]
    fn transcribing_segment_prose_and_params_match_the_emitted_payload() {
        assert_eq!(
            transcribing_segment_message(1, 5, 1.2),
            "Transcribing segment 2 of 5 (1.2s)..."
        );
        assert_eq!(
            transcribing_segment_params(1, 5, 1.2),
            json!({ "current": 2, "total": 5, "duration_sec": 1.2 })
        );
    }

    #[test]
    fn transcribing_segment_numbers_segments_from_one() {
        assert_eq!(
            transcribing_segment_message(0, 2, 1.0),
            "Transcribing segment 1 of 2 (1.0s)..."
        );
        assert_eq!(transcribing_segment_params(0, 2, 1.0)["current"], 1);
    }

    /// The milestone prose both bars emit is pinned here (the payloads and
    /// the D7 fallback rule keep them on the wire); an edit here is an
    /// emitter wire change.
    #[test]
    fn shared_milestone_prose_is_byte_identical_to_the_payloads() {
        assert_eq!(MESSAGE_DECODING_FILE, "Decoding audio file...");
        assert_eq!(MESSAGE_CONVERTING_FORMAT, "Converting audio format...");
        assert_eq!(MESSAGE_DETECTING_SEGMENTS, "Detecting speech segments...");
        assert_eq!(MESSAGE_LOADING_ENGINE, "Loading transcription engine...");
        assert_eq!(MESSAGE_WRITING_FILES, "Writing transcript files...");
    }

    /// The forwarded report must carry the decoder's own message/code/params
    /// untouched (the decoder owns that sentence, spec D7) and only rewrite
    /// the percentage into the band.
    #[test]
    fn forward_decode_progress_rewrites_only_the_percentage() {
        use super::super::decoder::DecodeProgress;
        use std::sync::{Arc, Mutex};

        let seen: Arc<Mutex<Vec<(u32, String, String, Option<Value>)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let callback = forward_decode_progress(15, move |percent, message, code, params| {
            sink.lock()
                .unwrap()
                .push((percent, message.to_string(), code.to_string(), params));
        });

        callback(&DecodeProgress {
            percent: 60,
            message: "Decoding audio: 60%".to_string(),
            code: "decoding_percent",
            params: Some(json!({ "percent": 60 })),
        });

        let reports = seen.lock().unwrap();
        assert_eq!(reports.len(), 1);
        let (percent, message, code, params) = &reports[0];
        assert_eq!(*percent, 18, "15 + 60 * 0.05, truncated");
        assert_eq!(message, "Decoding audio: 60%");
        assert_eq!(code, "decoding_percent");
        assert_eq!(*params, Some(json!({ "percent": 60 })));
    }

    /// The band map is the exact arithmetic the closures used inline:
    /// truncation, not rounding, and the band tops at base+5.
    #[test]
    fn band_percent_maps_0_to_100_into_the_five_point_band() {
        assert_eq!(band_percent(15, 0), 15);
        assert_eq!(band_percent(15, 19), 15);
        assert_eq!(band_percent(15, 20), 16);
        assert_eq!(band_percent(15, 99), 19);
        assert_eq!(band_percent(15, 100), 20);
        assert_eq!(band_percent(20, 100), 25);
        assert_eq!(band_percent(25, 100), 30);
    }
}
