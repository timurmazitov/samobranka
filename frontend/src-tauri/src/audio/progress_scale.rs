// audio/progress_scale.rs
//
// The one scale the import and retranscription progress bars share. Both
// batch paths show the same spliced bar, so the milestones are defined once
// here and cannot drift apart between the two files or the shared tests.
//
// The scale has three owners: transcription runs 30..70, saving owns
// 70..75, and the top band 75..100 belongs to the diarization pass — fed by
// the frontend's shared pass state as one number (see
// `frontend/src/lib/diarization.ts`), which is why no native milestone may
// reach past [`DIARIZATION_BAND_START`] and no native event may report 100
// while a pass can still run.

/// Transcription's slice of the bar: `[start, end)`. The last segment stays
/// one point below the top so "saving" is visibly a new milestone.
pub(crate) const TRANSCRIPTION_BAND: (u32, u32) = (30, 70);

/// The saving milestone, the bottom of the save band.
pub(crate) const SAVING_PROGRESS: u32 = 70;

/// The top of the native scale, the bottom of the diarization band the
/// frontend fills from the shared pass state. The frontend mirrors this exact
/// number as `DIARIZATION_BAND_START` in `frontend/src/lib/diarization.ts`;
/// the shared scale test (`frontend/tests/components`/`tests/lib`) keeps the
/// two honest.
pub(crate) const DIARIZATION_BAND_START: u32 = 75;

/// The bar percentage for transcribing segment `index` of `count`. The band
/// is [`TRANSCRIPTION_BAND`]; the last segment stays one point below the top
/// so "saving" is visibly a new milestone.
pub(crate) fn transcription_progress(index: usize, count: usize) -> u32 {
    let (start, end) = TRANSCRIPTION_BAND;
    let span = end - start;
    let fraction = (index as f32 / count.max(1) as f32).min(1.0);
    start + (fraction * (span - 1) as f32) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole batch-bar scale in one pin: transcription stops below the
    /// save band, saving stops exactly at the diarization band, and the last
    /// native milestone can never be 100. Both batch paths emit through
    /// these constants, so one pin covers both bars.
    #[test]
    fn the_scale_hands_the_bar_to_the_pass_below_a_hundred() {
        assert_eq!(TRANSCRIPTION_BAND, (30, 70));
        assert_eq!(SAVING_PROGRESS, 70);
        assert_eq!(DIARIZATION_BAND_START, 75);
        assert!(DIARIZATION_BAND_START < 100, "only the frontend terminal may show 100");
        assert!(SAVING_PROGRESS < DIARIZATION_BAND_START);
    }

    /// The segment ramp both batch paths share, pinned once.
    #[test]
    fn transcription_segments_stay_inside_their_band() {
        assert_eq!(transcription_progress(0, 10), 30);
        assert_eq!(transcription_progress(1, 10), 33);
        assert_eq!(transcription_progress(9, 10), 65);
        assert!(transcription_progress(10, 10) < TRANSCRIPTION_BAND.1);
        // A single segment and an empty job still read as the band's start.
        assert_eq!(transcription_progress(0, 1), 30);
        assert_eq!(transcription_progress(0, 0), 30);
        for index in 0..12 {
            for count in [0usize, 1, 5, 12] {
                let value = transcription_progress(index, count);
                assert!((TRANSCRIPTION_BAND.0..TRANSCRIPTION_BAND.1).contains(&value));
            }
        }
    }
}
