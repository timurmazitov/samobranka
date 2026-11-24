use crate::api::{TranscriptSearchResult, TranscriptSegment};
use crate::database::meeting_facts::usable_duration_seconds;
use crate::database::repositories::speaker::{self, ReconcileOutcome};
use chrono::Utc;
use sqlx::{Connection, Error as SqlxError, SqlitePool};
use log::{error, info};
use std::collections::HashSet;
use uuid::Uuid;

/// Errors of the transcript-row commands. `Display` messages are user-facing
/// and written in English, like the rest of the UI strings; they never carry
/// the meeting content itself.
#[derive(Debug)]
pub enum TranscriptError {
    /// The edited text is empty or whitespace-only after normalization.
    EmptyText,
    /// The batch names a meeting that does not exist.
    MeetingNotFound(String),
    /// A requested segment id does not exist or belongs to another meeting.
    /// The payload is the id — never any transcript content.
    TranscriptNotFound(String),
    Database(SqlxError),
}

impl std::fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscriptError::EmptyText => write!(f, "transcript text cannot be empty"),
            TranscriptError::MeetingNotFound(id) => write!(f, "meeting not found: {id}"),
            TranscriptError::TranscriptNotFound(id) => write!(f, "transcript not found: {id}"),
            TranscriptError::Database(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for TranscriptError {}

impl From<SqlxError> for TranscriptError {
    fn from(error: SqlxError) -> Self {
        TranscriptError::Database(error)
    }
}

/// The authoritative single-line form of an edited transcript: every run of
/// whitespace (newlines and tabs from pastes included) collapses to one
/// space and the ends are trimmed. Mirrors what the display already does, so
/// the saved value matches what the user sees after a reload.
fn normalize_transcript_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct TranscriptsRepository;

impl TranscriptsRepository {
    /// Saves a new meeting and its associated transcript segments.
    /// This function uses a transaction to ensure that either both the meeting
    /// and all its transcripts are saved, or none of them are.
    pub async fn save_transcript(
        pool: &SqlitePool,
        meeting_title: &str,
        transcripts: &[TranscriptSegment],
        folder_path: Option<String>,
    ) -> Result<String, SqlxError> {
        let meeting_id = format!("meeting-{}", Uuid::new_v4());

        // The folder read is blocking file I/O, so it happens off the async
        // worker and before the connection is checked out: no transaction is
        // held open while the disk is asked.
        let folder_path_for_facts = folder_path.clone();
        let folder_facts = match tokio::task::spawn_blocking(move || {
            crate::database::meeting_facts::read_folder_meeting_facts(
                folder_path_for_facts.as_deref(),
            )
        })
        .await
        {
            Ok(facts) => facts,
            Err(error) => {
                // The read task itself died (panic/cancel): treat the folder as
                // unreadable and let the honest fallbacks below fill the row.
                log::warn!("Recording folder facts could not be read: {}", error);
                Default::default()
            }
        };

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let now = Utc::now();

        // The meeting's own moment and length: the folder is authoritative
        // because it knows when the recording started. Without a usable folder
        // the row still gets the honest approximations the spec allows — the
        // save moment and the end of the last segment — and otherwise NULL.
        // A last end that is not a real positive measurement is "unknown".
        let fallback_duration = usable_duration_seconds(
            transcripts
                .iter()
                .filter_map(|segment| segment.audio_end_time)
                .reduce(f64::max),
        );
        let recorded_at = folder_facts
            .recorded_at_ms
            .map(chrono::DateTime::<Utc>::from_timestamp_millis)
            .flatten()
            .unwrap_or(now);
        let duration_seconds = folder_facts.duration_seconds.or(fallback_duration);

        // 1. Create the new meeting
        let result = sqlx::query(
            "INSERT INTO meetings (id, title, created_at, updated_at, folder_path, recorded_at, duration_seconds)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&meeting_id)
        .bind(meeting_title)
        .bind(now)
        .bind(now)
        .bind(&folder_path)
        .bind(recorded_at)
        .bind(duration_seconds)
        .execute(&mut *transaction)
        .await;

        if let Err(e) = result {
            error!("Failed to create meeting with id: {}", meeting_id);
            transaction.rollback().await?;
            return Err(e);
        }

        info!("Successfully created meeting with id: {}", meeting_id);

        // 2. Save each transcript segment with audio timing fields
        for segment in transcripts {
            let transcript_id = format!("transcript-{}", Uuid::new_v4());
            let result = sqlx::query(
                "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, audio_start_time, audio_end_time, duration, speaker)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(&transcript_id)
            .bind(&meeting_id)
            .bind(&segment.text)
            .bind(&segment.timestamp)
            .bind(segment.audio_start_time)
            .bind(segment.audio_end_time)
            .bind(segment.duration)
            .bind(&segment.speaker)
            .execute(&mut *transaction)
            .await;

            if let Err(e) = result {
                error!("Failed to save transcript segment for meeting {}", meeting_id);
                transaction.rollback().await?;
                return Err(e);
            }
        }

        info!(
            "Successfully saved {} transcript segments for meeting {}",
            transcripts.len(),
            meeting_id
        );

        // Commit the transaction
        transaction.commit().await?;

        Ok(meeting_id)
    }

    /// Replaces the text of a single transcript segment. Only the text column
    /// changes: timings and speaker attribution survive, and the meeting's
    /// `updated_at` bumps like a rename does. The stored value is the
    /// normalized single-line form (see [`normalize_transcript_text`]).
    pub async fn update_text(
        pool: &SqlitePool,
        transcript_id: &str,
        text: &str,
    ) -> Result<(), TranscriptError> {
        // Validation happens before a connection is checked out.
        let text = normalize_transcript_text(text);
        if text.is_empty() {
            return Err(TranscriptError::EmptyText);
        }

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let row: Option<(String, String)> =
            sqlx::query_as("SELECT meeting_id, transcript FROM transcripts WHERE id = ?")
                .bind(transcript_id)
                .fetch_optional(&mut *transaction)
                .await?;
        let Some((meeting_id, current_text)) = row else {
            transaction.rollback().await?;
            return Err(TranscriptError::TranscriptNotFound(transcript_id.to_string()));
        };

        if current_text == text {
            transaction.rollback().await?;
            return Ok(());
        }

        sqlx::query("UPDATE transcripts SET transcript = ? WHERE id = ?")
            .bind(&text)
            .bind(transcript_id)
            .execute(&mut *transaction)
            .await?;

        // An edit is a change of the meeting, so it bumps the meeting
        // timestamp like a rename and a per-segment speaker change do.
        sqlx::query("UPDATE meetings SET updated_at = ? WHERE id = ?")
            .bind(Utc::now().naive_utc())
            .bind(&meeting_id)
            .execute(&mut *transaction)
            .await?;

        transaction.commit().await?;
        Ok(())
    }

    /// Searches for a query string within the transcripts.
    /// It returns a list of matching transcripts with context.
    pub async fn search_transcripts(
        pool: &SqlitePool,
        query: &str,
    ) -> Result<Vec<TranscriptSearchResult>, SqlxError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        let search_query = format!("%{}%", query.to_lowercase());

        let rows = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT m.id, m.title, t.transcript, t.timestamp
             FROM meetings m
             JOIN transcripts t ON m.id = t.meeting_id
             WHERE LOWER(t.transcript) LIKE ?",
        )
        .bind(&search_query)
        .fetch_all(pool)
        .await?;

        let results = rows
            .into_iter()
            .map(|(id, title, transcript, timestamp)| {
                let match_context = Self::get_match_context(&transcript, query);
                TranscriptSearchResult {
                    id,
                    title,
                    match_context,
                    timestamp,
                }
            })
            .collect();

        Ok(results)
    }

    /// Deletes a batch of the meeting's speech segments in one transaction:
    /// the meeting must exist, every id must belong to it (an unknown or
    /// foreign id rejects the whole batch — there is no partial delete), the
    /// meeting's `updated_at` bumps like a text edit does, and the speaker
    /// assignments are reconciled once so a label whose last segment went
    /// away loses its binding and any orphaned directory person with it. The
    /// caller emits the names-reset hint from the outcome after the commit
    /// (see the retranscription and diarization call sites).
    ///
    /// The batch takes a list from the start: the single-delete button and the
    /// bulk toolbar share this one command. Duplicate ids are deduplicated
    /// and an empty batch is a no-op (an `IN ()` is invalid SQL). `Display`
    /// of the error carries ids only, never transcript content.
    pub async fn delete_batch(
        pool: &SqlitePool,
        meeting_id: &str,
        ids: &[String],
    ) -> Result<ReconcileOutcome, TranscriptError> {
        // An empty batch deletes nothing and edits nothing: the honest
        // answer is a quiet success, not a failed query.
        if ids.is_empty() {
            return Ok(ReconcileOutcome::default());
        }
        if meeting_id.trim().is_empty() {
            return Err(TranscriptError::MeetingNotFound(meeting_id.to_string()));
        }

        let mut seen = HashSet::new();
        let unique_ids: Vec<&String> = ids.iter().filter(|id| seen.insert(id.as_str())).collect();

        let mut conn = pool.acquire().await?;
        let mut transaction = conn.begin().await?;

        let meeting_exists: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_optional(&mut *transaction)
            .await?;
        if meeting_exists.is_none() {
            transaction.rollback().await?;
            return Err(TranscriptError::MeetingNotFound(meeting_id.to_string()));
        }

        // Ownership of the whole batch in one statement: the rows the meeting
        // owns are compared against the request, so any unknown or foreign id
        // rejects everything. There is no reusable `IN (...)` helper in the
        // codebase, so the placeholders are built here.
        let mut ownership_sql =
            String::from("SELECT id FROM transcripts WHERE meeting_id = ? AND id IN (");
        ownership_sql.push_str(&vec!["?"; unique_ids.len()].join(", "));
        ownership_sql.push(')');
        let mut ownership = sqlx::query_as::<_, (String,)>(&ownership_sql).bind(meeting_id);
        for id in &unique_ids {
            ownership = ownership.bind(id);
        }
        let owned: HashSet<String> = ownership
            .fetch_all(&mut *transaction)
            .await?
            .into_iter()
            .map(|(id,)| id)
            .collect();

        for id in &unique_ids {
            if !owned.contains(id.as_str()) {
                transaction.rollback().await?;
                return Err(TranscriptError::TranscriptNotFound(id.to_string()));
            }
        }

        let mut delete_sql = String::from("DELETE FROM transcripts WHERE meeting_id = ? AND id IN (");
        delete_sql.push_str(&vec!["?"; unique_ids.len()].join(", "));
        delete_sql.push(')');
        let mut delete = sqlx::query(&delete_sql).bind(meeting_id);
        for id in &unique_ids {
            delete = delete.bind(id);
        }
        delete.execute(&mut *transaction).await?;

        // A delete is a change of the meeting, so it bumps the meeting
        // timestamp like a rename, an edit and a speaker change do. (When the
        // reconcile below also removes bindings it bumps again; the second
        // bump is harmless.)
        sqlx::query("UPDATE meetings SET updated_at = ? WHERE id = ?")
            .bind(Utc::now().naive_utc())
            .bind(meeting_id)
            .execute(&mut *transaction)
            .await?;

        // One reconcile per delete, inside the same transaction: its label
        // set is read from `transcripts`, so it sees exactly the survivors.
        let outcome = speaker::reconcile_meeting_speaker_assignments(&mut *transaction, meeting_id).await?;

        transaction.commit().await?;
        Ok(outcome)
    }

    /// Helper function to extract a snippet of text around the first match of a query.
    fn get_match_context(transcript: &str, query: &str) -> String {
        let transcript_lower = transcript.to_lowercase();
        let query_lower = query.to_lowercase();

        match transcript_lower.find(&query_lower) {
            Some(match_index) => {
                let start_index = match_index.saturating_sub(100);
                let end_index = (match_index + query.len() + 100).min(transcript.len());

                let mut context = String::new();
                if start_index > 0 {
                    context.push_str("...");
                }
                context.push_str(&transcript[start_index..end_index]);
                if end_index < transcript.len() {
                    context.push_str("...");
                }
                context
            }
            None => transcript.chars().take(200).collect(), // Fallback to the start of the transcript
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_transcript_text, TranscriptError, TranscriptsRepository};
    use crate::api::TranscriptSegment;
    use crate::database::repositories::meeting::MeetingsRepository;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Row, SqlitePool};

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
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

    fn segment(text: &str, end_seconds: f64) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("transcript-{text}"),
            text: text.to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            audio_start_time: Some(end_seconds - 1.0),
            audio_end_time: Some(end_seconds),
            duration: Some(1.0),
            speaker: None,
        }
    }

    /// A recording folder as `recording_saver` leaves it after a stop: the
    /// start moment and the finished length live in `metadata.json`.
    fn folder_with_metadata(metadata: serde_json::Value) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join("metadata.json"),
            serde_json::to_string(&metadata).unwrap(),
        )
        .unwrap();
        dir
    }

    /// The meeting as the list command reads it, so the assertions see exactly
    /// what the sidebar will receive.
    async fn listed_meeting(pool: &SqlitePool, meeting_id: &str) -> crate::database::models::MeetingModel {
        MeetingsRepository::get_meetings(pool)
            .await
            .unwrap()
            .into_iter()
            .find(|meeting| meeting.id == meeting_id)
            .expect("the saved meeting is listed")
    }

    async fn meeting_row(pool: &SqlitePool, meeting_id: &str) -> (String, Option<String>, Option<f64>) {
        sqlx::query_as("SELECT created_at, recorded_at, duration_seconds FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_recording_without_usable_metadata_still_gets_an_honest_moment_and_length() {
        let pool = migrated_pool().await;
        // The folder exists but the file is absent: the saver had no chance to
        // write it, so the save point is the best moment there is.
        let folder = tempfile::tempdir().unwrap();
        let before = chrono::Utc::now();

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Recovered call",
            &[segment("first", 10.0), segment("last", 90.0)],
            Some(folder.path().to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        let recorded_at = meeting
            .recorded_at
            .as_ref()
            .map(|moment| moment.0)
            .expect("the save moment stands in for a missing file");
        assert!(
            recorded_at >= before && recorded_at <= chrono::Utc::now(),
            "the stand-in moment is the save moment, not an arbitrary date"
        );
        assert_eq!(
            meeting.duration_seconds,
            Some(90.0),
            "without a file the length falls back to the end of the last segment"
        );
    }

    #[tokio::test]
    async fn an_unparsable_length_in_the_file_falls_back_to_the_last_segment() {
        let pool = migrated_pool().await;
        let folder = folder_with_metadata(serde_json::json!({
            "created_at": "2026-11-18T14:32:05+00:00",
            "duration_seconds": "about an hour",
        }));

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Half-broken call",
            &[segment("only", 600.0)],
            Some(folder.path().to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        assert_eq!(
            meeting
                .recorded_at
                .as_ref()
                .map(|moment| moment.0.to_rfc3339()),
            Some("2026-11-18T14:32:05+00:00".to_string()),
            "the start moment in the file is still good"
        );
        assert_eq!(
            meeting.duration_seconds,
            Some(600.0),
            "an unreadable length does not discard the file's moment"
        );
    }

    #[tokio::test]
    async fn a_missing_folder_still_saves_with_the_honest_fallbacks() {
        let pool = migrated_pool().await;
        let before = chrono::Utc::now();

        // The path is not a folder on disk at all. The save must behave exactly
        // as it does for a folder without `metadata.json`: never fail, never
        // leave the row dateless when the save moment is honest.
        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Folderless call",
            &[segment("only", 42.5)],
            Some("/nonexistent/samobranka/meeting-folder".to_string()),
        )
        .await
        .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        let recorded_at = meeting
            .recorded_at
            .as_ref()
            .map(|moment| moment.0)
            .expect("the save moment stands in for a missing folder");
        assert!(recorded_at >= before && recorded_at <= chrono::Utc::now());
        assert_eq!(meeting.duration_seconds, Some(42.5));
    }

    #[tokio::test]
    async fn a_last_segment_ending_at_zero_keeps_the_length_unknown() {
        let pool = migrated_pool().await;

        // A segment may carry a degenerate end time (a zero-length VAD chunk).
        // That is "nothing measured", not a real 0.0-second meeting — exactly
        // how the import path and the backfill read the same value.
        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Zero-length chunk",
            &[segment("nothing", 0.0)],
            None,
        )
        .await
        .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        assert_eq!(
            meeting.duration_seconds, None,
            "a zero end is unknown, never a stored 0.0"
        );
    }

    #[tokio::test]
    async fn a_negative_last_segment_end_keeps_the_length_unknown() {
        let pool = migrated_pool().await;
        let mut broken = segment("negative", -4.0);
        broken.audio_end_time = Some(-4.0);

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Negative chunk", &[broken], None)
                .await
                .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        assert_eq!(
            meeting.duration_seconds, None,
            "a negative end is unknown, never a stored negative length"
        );
    }

    #[tokio::test]
    async fn a_meeting_with_nothing_to_measure_keeps_an_unknown_length() {
        let pool = migrated_pool().await;

        let meeting_id =
            TranscriptsRepository::save_transcript(&pool, "Empty call", &[], None)
                .await
                .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;
        assert_eq!(
            meeting.duration_seconds, None,
            "no file and no segments means unknown, never zero"
        );
    }

    #[tokio::test]
    async fn a_saved_recording_keeps_its_audit_created_at() {
        let pool = migrated_pool().await;
        let folder = folder_with_metadata(serde_json::json!({
            "created_at": "2026-11-18T14:32:05+00:00",
            "duration_seconds": 60,
        }));
        let before = chrono::Utc::now();

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Audited call",
            &[segment("hello", 5.0)],
            Some(folder.path().to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        let (created_at, _, _) = meeting_row(&pool, &meeting_id).await;
        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at)
            .expect("created_at stays an RFC3339 moment")
            .with_timezone(&chrono::Utc);
        assert!(
            created_at >= before,
            "created_at remains the moment the row appeared"
        );
    }

    #[tokio::test]
    async fn saving_a_recording_takes_the_meeting_moment_and_length_from_its_folder() {
        let pool = migrated_pool().await;
        let folder = folder_with_metadata(serde_json::json!({
            "version": "1.0",
            "created_at": "2026-11-18T14:32:05+00:00",
            "completed_at": "2026-11-18T15:55:00+00:00",
            "duration_seconds": 4_975.5,
            "status": "completed",
        }));

        let meeting_id = TranscriptsRepository::save_transcript(
            &pool,
            "Planning call",
            &[segment("first", 10.0), segment("last", 20.0)],
            Some(folder.path().to_string_lossy().to_string()),
        )
        .await
        .unwrap();

        let meeting = listed_meeting(&pool, &meeting_id).await;

        assert_eq!(
            meeting
                .recorded_at
                .as_ref()
                .map(|moment| moment.0.to_rfc3339()),
            Some("2026-11-18T14:32:05+00:00".to_string()),
            "the meeting is dated by the start of the recording, not by the save"
        );
        assert_eq!(
            meeting.duration_seconds,
            Some(4_975.5),
            "the length is the recording's own, not the end of the last segment"
        );
        assert_ne!(
            meeting.created_at.0.to_rfc3339(),
            "2026-11-18T14:32:05+00:00",
            "created_at stays the moment the row appeared"
        );
    }

    // --- update_text -----------------------------------------------------
    //
    // Fixtures follow the speaker-repository style: a bare meeting and one
    // transcript row the tests can then edit by id.

    async fn insert_meeting(pool: &SqlitePool, meeting_id: &str) {
        sqlx::query("INSERT INTO meetings (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(meeting_id)
            .bind("Meeting")
            .bind("2024-01-01T00:00:00Z")
            .bind("2024-01-01T00:00:00Z")
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_transcript(
        pool: &SqlitePool,
        id: &str,
        meeting_id: &str,
        transcript: &str,
        speaker: Option<&str>,
    ) {
        sqlx::query(
            "INSERT INTO transcripts (id, meeting_id, transcript, timestamp, speaker, audio_start_time, audio_end_time, duration)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(meeting_id)
        .bind(transcript)
        .bind("2024-01-01T00:00:00Z")
        .bind(speaker)
        .bind(5.0)
        .bind(9.5)
        .bind(4.5)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn updated_at(pool: &SqlitePool, meeting_id: &str) -> String {
        sqlx::query("SELECT updated_at FROM meetings WHERE id = ?")
            .bind(meeting_id)
            .fetch_one(pool)
            .await
            .unwrap()
            .get("updated_at")
    }

    async fn transcript_row(pool: &SqlitePool, id: &str) -> (String, Option<String>, Option<f64>, Option<f64>, Option<f64>) {
        let row = sqlx::query(
            "SELECT transcript, speaker, audio_start_time, audio_end_time, duration FROM transcripts WHERE id = ?",
        )
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap();
        (
            row.get("transcript"),
            row.get("speaker"),
            row.get("audio_start_time"),
            row.get("audio_end_time"),
            row.get("duration"),
        )
    }

    #[tokio::test]
    async fn editing_text_changes_only_the_text_and_keeps_everything_else() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Old words", Some("speaker_0")).await;

        TranscriptsRepository::update_text(&pool, "t-0", "Fixed words")
            .await
            .unwrap();

        assert_eq!(
            transcript_row(&pool, "t-0").await,
            (
                "Fixed words".to_string(),
                Some("speaker_0".to_string()),
                Some(5.0),
                Some(9.5),
                Some(4.5),
            ),
            "timings and speaker survive the edit untouched"
        );
    }

    #[tokio::test]
    async fn editing_the_text_of_an_unknown_transcript_is_an_error() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;

        let error = TranscriptsRepository::update_text(&pool, "nope", "Any text")
            .await
            .unwrap_err();

        assert!(
            matches!(error, TranscriptError::TranscriptNotFound(_)),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn a_text_edit_bumps_the_meeting_timestamp() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Old", None).await;
        let before = updated_at(&pool, "meeting-1").await;

        TranscriptsRepository::update_text(&pool, "t-0", "New")
            .await
            .unwrap();

        assert_ne!(updated_at(&pool, "meeting-1").await, before);
    }

    #[tokio::test]
    async fn resaving_the_same_text_does_not_bump_the_timestamp() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Same", Some("speaker_0")).await;
        let before = updated_at(&pool, "meeting-1").await;

        TranscriptsRepository::update_text(&pool, "t-0", "Same")
            .await
            .unwrap();

        assert_eq!(updated_at(&pool, "meeting-1").await, before);
    }

    #[tokio::test]
    async fn inserted_newlines_and_double_spaces_collapse_to_single_spaces() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Old", None).await;

        TranscriptsRepository::update_text(&pool, "t-0", "  first  line\n\tsecond   line  ")
            .await
            .unwrap();

        let (text, ..) = transcript_row(&pool, "t-0").await;
        assert_eq!(text, "first line second line");
    }

    #[tokio::test]
    async fn saving_a_normalization_of_the_current_text_changes_nothing() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "One two", None).await;
        let before = updated_at(&pool, "meeting-1").await;

        TranscriptsRepository::update_text(&pool, "t-0", "One  two\n")
            .await
            .unwrap();

        assert_eq!(updated_at(&pool, "meeting-1").await, before);
    }

    #[tokio::test]
    async fn an_empty_or_whitespace_only_text_is_rejected() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Keep me", Some("speaker_0")).await;

        for text in ["", "   ", "\n\t "] {
            let error = TranscriptsRepository::update_text(&pool, "t-0", text)
                .await
                .unwrap_err();
            assert!(
                matches!(error, TranscriptError::EmptyText),
                "{text:?} must be rejected, got {error:?}"
            );
        }

        let (stored, ..) = transcript_row(&pool, "t-0").await;
        assert_eq!(stored, "Keep me", "nothing was written");
    }

    /// The normalization both sides share: the frontend mirror
    /// (`frontend/src/lib/transcript-format.ts`) and this repository function
    /// are pinned to the same fixture, so the optimistic row value cannot
    /// drift from what the database stores (same shared-fixture idea as
    /// pinning DIARIZATION_BAND_START against progress_scale.rs).
    #[test]
    fn normalize_transcript_text_matches_the_shared_fixture() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/transcript-normalize.json"))
                .expect("the normalization fixture is valid JSON");
        let cases = fixture["cases"]
            .as_array()
            .expect("the fixture carries a cases array");
        assert!(
            cases.len() >= 10,
            "the fixture must keep its full case set, got {}",
            cases.len()
        );

        for case in cases {
            let input = case["input"].as_str().expect("case input is a string");
            let expected = case["expected"]
                .as_str()
                .expect("case expected is a string");
            assert_eq!(
                normalize_transcript_text(input),
                expected,
                "case: {}",
                case["description"].as_str().unwrap_or("?")
            );
        }
    }

    // --- delete_batch ----------------------------------------------------
    //
    // The batch delete runs one transaction: ownership check of every id,
    // DELETE, meeting timestamp bump, and a single reconcile of the speaker
    // assignments. The fixtures reuse the update_text style: bare meetings
    // and transcript rows, plus the speaker-binding helpers below.

    async fn transcript_ids(pool: &SqlitePool, meeting_id: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT id FROM transcripts WHERE meeting_id = ? ORDER BY id")
            .bind(meeting_id)
            .fetch_all(pool)
            .await
            .unwrap();
        rows.into_iter().map(|row| row.get("id")).collect()
    }

    async fn insert_person(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query("INSERT INTO speakers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
            .bind(id)
            .bind(name)
            .bind("2024-01-01T00:00:00Z")
            .bind("2024-01-01T00:00:00Z")
            .execute(pool)
            .await
            .unwrap();
    }

    async fn bind_speaker(pool: &SqlitePool, meeting_id: &str, label: &str, speaker_id: &str) {
        sqlx::query(
            "INSERT INTO meeting_speakers (id, meeting_id, label, speaker_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(format!("meeting-speaker-{meeting_id}-{label}"))
        .bind(meeting_id)
        .bind(label)
        .bind(speaker_id)
        .bind("2024-01-01T00:00:00Z")
        .bind("2024-01-01T00:00:00Z")
        .execute(pool)
        .await
        .unwrap();
    }

    async fn bound_labels(pool: &SqlitePool, meeting_id: &str) -> Vec<String> {
        let rows = sqlx::query("SELECT label FROM meeting_speakers WHERE meeting_id = ? ORDER BY label")
            .bind(meeting_id)
            .fetch_all(pool)
            .await
            .unwrap();
        rows.into_iter().map(|row| row.get("label")).collect()
    }

    async fn directory_names(pool: &SqlitePool) -> Vec<String> {
        let rows = sqlx::query("SELECT name FROM speakers ORDER BY name")
            .fetch_all(pool)
            .await
            .unwrap();
        rows.into_iter().map(|row| row.get("name")).collect()
    }

    #[tokio::test]
    async fn deleting_own_ids_removes_exactly_those_rows() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Keep", None).await;
        insert_transcript(&pool, "t-1", "meeting-1", "Drop", None).await;
        insert_transcript(&pool, "t-2", "meeting-1", "Drop too", None).await;

        TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-1".to_string(), "t-2".to_string()])
            .await
            .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, vec!["t-0"]);
    }

    #[tokio::test]
    async fn deleting_a_second_time_asks_for_the_same_ids_and_gets_nothing_back() {
        // The reconcile is idempotent and self-bumps only when it removes
        // something, so a batch that deletes nothing it still owns must not
        // fail. After the first delete the ids are gone, so the second call
        // reports them as not found and changes nothing.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Only", None).await;

        TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-0".to_string()])
            .await
            .unwrap();

        let error = TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-0".to_string()])
            .await
            .unwrap_err();
        assert!(
            matches!(error, TranscriptError::TranscriptNotFound(ref id) if id == "t-0"),
            "{error:?}"
        );
        assert_eq!(transcript_ids(&pool, "meeting-1").await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn deleting_the_last_segments_leaves_a_valid_empty_transcript() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "First", None).await;
        insert_transcript(&pool, "t-1", "meeting-1", "Second", None).await;

        TranscriptsRepository::delete_batch(
            &pool,
            "meeting-1",
            &["t-0".to_string(), "t-1".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn an_id_of_another_meeting_rejects_the_whole_batch_and_deletes_nothing() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_meeting(&pool, "meeting-2").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Mine", None).await;
        insert_transcript(&pool, "t-1", "meeting-2", "Theirs", None).await;

        let error = TranscriptsRepository::delete_batch(
            &pool,
            "meeting-1",
            &["t-0".to_string(), "t-1".to_string()],
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, TranscriptError::TranscriptNotFound(ref id) if id == "t-1"),
            "{error:?}"
        );
        assert_eq!(
            transcript_ids(&pool, "meeting-1").await,
            vec!["t-0"],
            "the owned id survives: a mixed batch is all-or-nothing"
        );
        assert_eq!(transcript_ids(&pool, "meeting-2").await, vec!["t-1"]);
    }

    #[tokio::test]
    async fn deleting_through_a_meeting_that_does_not_exist_is_an_error() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Ours", None).await;

        let error = TranscriptsRepository::delete_batch(
            &pool,
            "meeting-ghost",
            &["t-0".to_string()],
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, TranscriptError::MeetingNotFound(ref id) if id == "meeting-ghost"),
            "{error:?}"
        );
        assert_eq!(transcript_ids(&pool, "meeting-1").await, vec!["t-0"]);
    }

    #[tokio::test]
    async fn the_error_display_never_carries_the_transcript_text() {
        // Privacy contract: the id is the only payload the Display renders, so
        // the log line and the frontend toast cannot leak meeting content.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-secret", "meeting-1", "Confidential words", None).await;

        let error = TranscriptsRepository::delete_batch(
            &pool,
            "meeting-1",
            &["t-secret".to_string(), "t-missing".to_string()],
        )
        .await
        .unwrap_err();

        let display = error.to_string();
        assert!(display.contains("t-missing"), "{display}");
        assert!(!display.contains("Confidential words"), "{display}");
        assert!(!display.contains("t-secret"), "{display}");
    }

    #[tokio::test]
    async fn a_delete_bumps_the_meeting_timestamp() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Old", None).await;
        let before = updated_at(&pool, "meeting-1").await;

        TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-0".to_string()])
            .await
            .unwrap();

        assert_ne!(updated_at(&pool, "meeting-1").await, before);
    }

    #[tokio::test]
    async fn deleting_an_empty_batch_changes_nothing() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Keep me", None).await;
        let before = updated_at(&pool, "meeting-1").await;

        TranscriptsRepository::delete_batch(&pool, "meeting-1", &[])
            .await
            .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, vec!["t-0"]);
        assert_eq!(
            updated_at(&pool, "meeting-1").await, before,
            "an empty batch is a no-op, not a meeting edit"
        );
    }

    #[tokio::test]
    async fn a_repeated_id_in_the_batch_is_deleted_once_and_accepted() {
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Once", None).await;

        TranscriptsRepository::delete_batch(
            &pool,
            "meeting-1",
            &["t-0".to_string(), "t-0".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, Vec::<String>::new());
    }

    #[tokio::test]
    async fn deleting_a_speakers_last_segment_drops_their_binding_and_orphaned_person() {
        // Reconcile inside the delete transaction: speaker_1 loses its final
        // segment, so its name binding and the directory person it pointed at
        // go away, while speaker_0 keeps everything.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Anna speaking", Some("speaker_0")).await;
        insert_transcript(&pool, "t-1", "meeting-1", "Boris speaking", Some("speaker_1")).await;
        insert_person(&pool, "person-0", "Anna").await;
        insert_person(&pool, "person-1", "Boris").await;
        bind_speaker(&pool, "meeting-1", "speaker_0", "person-0").await;
        bind_speaker(&pool, "meeting-1", "speaker_1", "person-1").await;

        let outcome = TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-1".to_string()])
            .await
            .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, vec!["t-0"]);
        assert_eq!(bound_labels(&pool, "meeting-1").await, vec!["speaker_0"]);
        assert_eq!(directory_names(&pool).await, vec!["Anna"]);
        assert_eq!(outcome.removed_bindings, 1);
        assert_eq!(outcome.removed_people, 1);
        // Only one label of two vanished: this is not a full names reset.
        assert!(!outcome.names_reset);
    }

    #[tokio::test]
    async fn deleting_every_labelled_segment_reports_a_full_names_reset() {
        // When the batch removes the final segments of every named speaker,
        // the outcome says so once, which is the command's cue to emit the
        // speaker-names-reset event after the commit.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Anna speaking", Some("speaker_0")).await;
        insert_transcript(&pool, "t-1", "meeting-1", "Boris speaking", Some("speaker_1")).await;
        insert_person(&pool, "person-0", "Anna").await;
        insert_person(&pool, "person-1", "Boris").await;
        bind_speaker(&pool, "meeting-1", "speaker_0", "person-0").await;
        bind_speaker(&pool, "meeting-1", "speaker_1", "person-1").await;

        let outcome = TranscriptsRepository::delete_batch(
            &pool,
            "meeting-1",
            &["t-0".to_string(), "t-1".to_string()],
        )
        .await
        .unwrap();

        assert_eq!(bound_labels(&pool, "meeting-1").await, Vec::<String>::new());
        assert_eq!(directory_names(&pool).await, Vec::<String>::new());
        assert!(outcome.names_reset, "every binding was removed: {outcome:?}");
        assert_eq!(outcome.removed_bindings, 2);
        assert_eq!(outcome.removed_people, 2);
    }

    #[tokio::test]
    async fn deleting_unlabelled_segments_keeps_every_name() {
        // The reconcile is a no-op when no label disappears: deleting rows
        // without a speaker (or a speaker with segments left) keeps bindings
        // and directory people untouched.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Anna again", Some("speaker_0")).await;
        insert_transcript(&pool, "t-1", "meeting-1", "Noise without speaker", None).await;
        insert_person(&pool, "person-0", "Anna").await;
        bind_speaker(&pool, "meeting-1", "speaker_0", "person-0").await;

        let outcome = TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-1".to_string()])
            .await
            .unwrap();

        assert_eq!(transcript_ids(&pool, "meeting-1").await, vec!["t-0"]);
        assert_eq!(bound_labels(&pool, "meeting-1").await, vec!["speaker_0"]);
        assert_eq!(directory_names(&pool).await, vec!["Anna"]);
        assert_eq!(outcome.removed_bindings, 0);
        assert!(!outcome.names_reset);
    }

    #[tokio::test]
    async fn deleting_touches_only_the_named_meetings_speakers() {
        // The two-meeting fixture from the reconcile tests: a delete in one
        // meeting never reaches the other meeting's bindings or people.
        let pool = migrated_pool().await;
        insert_meeting(&pool, "meeting-1").await;
        insert_meeting(&pool, "meeting-2").await;
        insert_transcript(&pool, "t-0", "meeting-1", "Only row of one", Some("speaker_0")).await;
        insert_transcript(&pool, "t-1", "meeting-2", "Other meeting row", Some("speaker_0")).await;
        insert_person(&pool, "person-0", "Shared name").await;
        bind_speaker(&pool, "meeting-1", "speaker_0", "person-0").await;
        bind_speaker(&pool, "meeting-2", "speaker_0", "person-0").await;

        TranscriptsRepository::delete_batch(&pool, "meeting-1", &["t-0".to_string()])
            .await
            .unwrap();

        assert_eq!(bound_labels(&pool, "meeting-1").await, Vec::<String>::new());
        assert_eq!(bound_labels(&pool, "meeting-2").await, vec!["speaker_0"]);
        assert_eq!(
            directory_names(&pool).await,
            vec!["Shared name"],
            "the person is still referenced by the other meeting"
        );
    }
}
