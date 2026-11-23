//! v0.5 transcription jobs (`jobs.kind = 'transcribe'`) and their worker.
//!
//! - Started only by [`Store::start_transcription`] (an audio/video version, an installed
//!   model, a language). The version's `text_status` becomes `pending`.
//! - Run one at a time by [`run_transcriber`], a worker separate from the extraction queue,
//!   so extracting a PDF never waits behind an hour-long recording.
//! - The audio is decoded and resampled (crate `media`), then recognised (trait
//!   [`Transcriber`]). Progress goes to `jobs.progress`; [`Store::cancel_job`] marks the job
//!   failed («Trascrizione annullata.») and the worker, which polls the job state, aborts
//!   whisper through its abort callback.
//! - A transcript replaces the previous one only when complete, in one transaction:
//!   `transcriptions`, `transcript_segments`, `document_text` (unit = segment index) and
//!   `chunks` (consecutive segments up to [`CHUNK_MAX_CHARS`], unit = first segment), so
//!   search, embeddings (0.4 consent rules) and chat pick it up.
//! - On failure or cancellation a previous transcript stays, and so does its status
//!   (`extracted` / `no_text`); without one the status becomes `failed` (cancelled:
//!   `not_applicable`).
//! - At startup, transcriptions left `running` by a crash are marked failed with
//!   «Trascrizione interrotta.» (not requeued: a long CPU job never restarts by itself; the
//!   user can retry).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};

use crate::chunks::{chunk_text, CHUNK_MAX_CHARS};
use crate::error::{CoreError, Result};
use crate::formats::DocumentKind;
use crate::jobs::{Job, JobState};
use crate::library::TextStatus;
use crate::media::{decode_to_whisper, DecodeError, WHISPER_SAMPLE_RATE};
use crate::models::{ModelManager, WhisperModelId};
use crate::store::{now, Store};
use crate::whisper::{
    default_threads, Language, Recognized, TranscribeError, TranscribeRequest, Transcriber,
};

pub const JOB_KIND_TRANSCRIBE: &str = "transcribe";

const NOT_MEDIA: &str = "Si possono trascrivere solo file audio e video.";
const ALREADY_RUNNING: &str = "La trascrizione di questo file è già in corso.";
const UNKNOWN_LANGUAGE: &str = "Lingua di trascrizione non valida.";
const NOT_CANCELLABLE: &str = "Si possono annullare solo le attività in attesa o in corso.";
const JOB_NOT_FOUND: &str = "L'attività non esiste più.";
pub const TRANSCRIPTION_CANCELLED: &str = "Trascrizione annullata.";
pub const EXTRACTION_CANCELLED: &str = "Estrazione annullata.";
pub const TRANSCRIPTION_INTERRUPTED: &str = "Trascrizione interrotta.";
pub const MODEL_NOT_INSTALLED: &str =
    "Modello non installato: scaricalo da Impostazioni → Trascrizione.";
const MODEL_LOAD_FAILED: &str =
    "Il modello di trascrizione non può essere caricato: prova a scaricarlo di nuovo.";
const CODEC_UNSUPPORTED: &str =
    "Codifica audio non supportata: trascrizione non disponibile per questa codifica.";
const AUDIO_CORRUPT: &str =
    "L'audio non può essere decodificato: il file potrebbe essere danneggiato.";
const TOO_LONG: &str = "La registrazione supera la durata massima trascrivibile (6 ore).";
const WHISPER_FAILED: &str = "La trascrizione non è riuscita.";
const BLOB_MISSING: &str = "Il file originale non si trova nell'archivio di Localis.";

/// Validates a language code from the UI (`validation`, field `language`).
pub fn parse_language(s: &str) -> Result<Language> {
    Language::parse(s).ok_or_else(|| CoreError::validation("language", UNKNOWN_LANGUAGE))
}

/// One segment of a stored transcript (`TranscriptSegment` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranscriptSegment {
    /// 1-based (= the `unit` of its text).
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// A transcription job taken by the worker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedTranscription {
    pub id: i64,
    pub version_id: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub media_type: String,
    /// `None` when the stored value is not a catalog id (the job then fails).
    pub model: Option<WhisperModelId>,
    pub language: Option<Language>,
}

/// Result of running one transcription.
#[derive(Debug, Clone, PartialEq)]
pub enum TranscriptionOutcome {
    Done {
        recognized: Recognized,
        /// Duration of the decoded audio.
        duration_ms: u64,
    },
    Failed {
        message: String,
        detail: String,
    },
    Cancelled,
}

fn failed(message: &str, detail: impl ToString) -> TranscriptionOutcome {
    TranscriptionOutcome::Failed {
        message: message.to_owned(),
        detail: detail.to_string(),
    }
}

/// Status a version returns to when a transcription does not complete.
fn status_without_new_transcript(
    tx: &Transaction<'_>,
    version_id: &str,
    cancelled: bool,
) -> Result<TextStatus> {
    let previous: Option<u32> = tx
        .query_row(
            "SELECT segment_count FROM transcriptions WHERE version_id = ?1",
            params![version_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match previous {
        Some(0) => TextStatus::NoText,
        Some(_) => TextStatus::Extracted,
        None if cancelled => TextStatus::NotApplicable,
        None => TextStatus::Failed,
    })
}

/// Groups consecutive segments into passages of at most [`CHUNK_MAX_CHARS`] characters:
/// (unit = first segment index, ordinal, text). A single overlong segment is split.
pub fn segment_passages(segments: &[TranscriptSegment]) -> Vec<(u32, u32, String)> {
    let mut out = Vec::new();
    let mut current: Option<(u32, String)> = None;
    for s in segments {
        let text = s.text.trim();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > CHUNK_MAX_CHARS {
            if let Some((unit, t)) = current.take() {
                out.push((unit, 1, t));
            }
            for span in chunk_text(text) {
                out.push((s.index, span.ordinal, span.text));
            }
            continue;
        }
        match &mut current {
            Some((_, t)) if t.chars().count() + 1 + text.chars().count() <= CHUNK_MAX_CHARS => {
                t.push(' ');
                t.push_str(text);
            }
            _ => {
                if let Some((unit, t)) = current.take() {
                    out.push((unit, 1, t));
                }
                current = Some((s.index, text.to_owned()));
            }
        }
    }
    if let Some((unit, t)) = current {
        out.push((unit, 1, t));
    }
    out
}

/// `mm:ss`, or `h:mm:ss` from one hour (chat locators and messages).
pub fn format_timestamp(ms: u64) -> String {
    let total = ms / 1000;
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 {
        format!("{h:02}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// Container extension for the decoder hint.
fn extension_for(media_type: &str) -> &'static str {
    match media_type {
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/wav" => "wav",
        _ => "mp4",
    }
}

impl Store {
    /// Queues a transcription of an audio/video version (`validation` for other kinds,
    /// `conflict` if one is already queued or running for it). The caller checks that the
    /// model is installed. Replaces the current transcript only when it completes.
    pub fn start_transcription(
        &mut self,
        version_id: &str,
        model: WhisperModelId,
        language: Language,
    ) -> Result<Job> {
        let version = self.get_version(version_id)?;
        if !version.kind.is_media() {
            return Err(CoreError::validation("versionId", NOT_MEDIA));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let busy: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM jobs WHERE version_id = ?1 AND kind = 'transcribe'
                              AND state IN ('queued', 'running'))",
            params![version_id],
            |r| r.get(0),
        )?;
        if busy {
            return Err(CoreError::conflict(ALREADY_RUNNING));
        }
        let now = now(&tx)?;
        tx.execute(
            "INSERT INTO jobs (version_id, kind, state, attempts, created_at, updated_at,
                 progress, model, language)
             VALUES (?1, 'transcribe', 'queued', 0, ?2, ?2, NULL, ?3, ?4)",
            params![version_id, now, model.as_str(), language.as_str()],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE document_versions SET text_status = 'pending' WHERE id = ?1",
            params![version_id],
        )?;
        tx.commit()?;
        self.get_job(id)
    }

    /// Cancels a queued or running job (`conflict` otherwise): it becomes `failed` with
    /// «Trascrizione annullata.» / «Estrazione annullata.». A running transcription is
    /// stopped by its worker within a fraction of a second; a running extraction finishes
    /// on its own and its result is discarded.
    pub fn cancel_job(&mut self, id: i64) -> Result<Job> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT kind, state, version_id FROM jobs WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((kind, state, version_id)) = row else {
            return Err(CoreError::not_found(JOB_NOT_FOUND));
        };
        if state != JobState::Queued.as_str() && state != JobState::Running.as_str() {
            return Err(CoreError::conflict(NOT_CANCELLABLE));
        }
        let (message, status) = if kind == JOB_KIND_TRANSCRIBE {
            (
                TRANSCRIPTION_CANCELLED,
                status_without_new_transcript(&tx, &version_id, true)?,
            )
        } else {
            (EXTRACTION_CANCELLED, TextStatus::Failed)
        };
        let now = now(&tx)?;
        tx.execute(
            "UPDATE jobs SET state = 'failed', error = ?2, error_detail = 'cancelled by the user',
                 progress = NULL, updated_at = ?3
             WHERE id = ?1",
            params![id, message, now],
        )?;
        tx.execute(
            "UPDATE document_versions SET text_status = ?2 WHERE id = ?1",
            params![version_id, status.as_str()],
        )?;
        tx.commit()?;
        self.get_job(id)
    }

    /// Segments of the current transcript of a version (empty if none).
    pub fn get_transcript(&self, version_id: &str) -> Result<Vec<TranscriptSegment>> {
        self.get_version(version_id)?;
        let mut stmt = self.conn.prepare(
            "SELECT idx, start_ms, end_ms, text FROM transcript_segments
             WHERE version_id = ?1 ORDER BY idx",
        )?;
        let rows = stmt.query_map(params![version_id], |r| {
            Ok(TranscriptSegment {
                index: r.get(0)?,
                start_ms: r.get::<_, i64>(1)?.max(0) as u64,
                end_ms: r.get::<_, i64>(2)?.max(0) as u64,
                text: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Marks the transcriptions left `running` by an interrupted run as failed
    /// («Trascrizione interrotta.»). Call once when the transcription worker starts.
    pub fn fail_interrupted_transcriptions(&mut self) -> Result<usize> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let jobs: Vec<(i64, String)> = {
            let mut stmt = tx.prepare(
                "SELECT id, version_id FROM jobs WHERE kind = 'transcribe' AND state = 'running'",
            )?;
            let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let now = now(&tx)?;
        for (id, version_id) in &jobs {
            let status = status_without_new_transcript(&tx, version_id, false)?;
            tx.execute(
                "UPDATE jobs SET state = 'failed', error = ?2,
                     error_detail = 'the app was closed during the transcription',
                     progress = NULL, updated_at = ?3
                 WHERE id = ?1",
                params![id, TRANSCRIPTION_INTERRUPTED, now],
            )?;
            tx.execute(
                "UPDATE document_versions SET text_status = ?2 WHERE id = ?1",
                params![version_id, status.as_str()],
            )?;
        }
        tx.commit()?;
        Ok(jobs.len())
    }

    /// Atomically takes the oldest queued transcription (queued → running, progress 0).
    pub fn claim_next_transcription(&mut self) -> Result<Option<ClaimedTranscription>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row = tx
            .query_row(
                "SELECT j.id, j.version_id, v.sha256, v.size_bytes, v.media_type, j.model,
                        j.language
                 FROM jobs j JOIN document_versions v ON v.id = j.version_id
                 WHERE j.kind = 'transcribe' AND j.state = 'queued' ORDER BY j.id LIMIT 1",
                [],
                |r| {
                    Ok(ClaimedTranscription {
                        id: r.get(0)?,
                        version_id: r.get(1)?,
                        sha256: r.get(2)?,
                        size_bytes: r.get::<_, i64>(3)?.max(0) as u64,
                        media_type: r.get(4)?,
                        model: r
                            .get::<_, Option<String>>(5)?
                            .as_deref()
                            .and_then(WhisperModelId::parse),
                        language: r
                            .get::<_, Option<String>>(6)?
                            .as_deref()
                            .and_then(Language::parse),
                    })
                },
            )
            .optional()?;
        let Some(job) = row else {
            return Ok(None);
        };
        let now = now(&tx)?;
        tx.execute(
            "UPDATE jobs SET state = 'running', attempts = attempts + 1, progress = 0,
                 error = NULL, error_detail = NULL, updated_at = ?2
             WHERE id = ?1 AND state = 'queued'",
            params![job.id, now],
        )?;
        tx.execute(
            "UPDATE document_versions SET text_status = 'pending' WHERE id = ?1",
            params![job.version_id],
        )?;
        tx.commit()?;
        Ok(Some(job))
    }

    /// Whether a running transcription uses `model` (its file must not be deleted).
    pub fn model_in_use(&self, model: WhisperModelId) -> Result<bool> {
        Ok(self.conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM jobs WHERE kind = 'transcribe' AND state = 'running'
                              AND model = ?1)",
            params![model.as_str()],
            |r| r.get(0),
        )?)
    }

    /// Whether job `id` is still running (false once cancelled or deleted).
    pub fn job_is_running(&self, id: i64) -> Result<bool> {
        Ok(self
            .conn
            .query_row(
                "SELECT state = 'running' FROM jobs WHERE id = ?1",
                params![id],
                |r| r.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
    }

    /// Stores the progress (0–100) of a running job; returns whether it is still running.
    pub fn set_job_progress(&self, id: i64, progress: u8) -> Result<bool> {
        let changed = self.conn.execute(
            "UPDATE jobs SET progress = ?2 WHERE id = ?1 AND state = 'running'",
            params![id, progress.min(100)],
        )?;
        Ok(changed > 0)
    }

    /// Records the outcome of a claimed transcription. Discarded when the job is no longer
    /// running (cancelled, or its document deleted meanwhile).
    pub fn finish_transcription(
        &mut self,
        job: &ClaimedTranscription,
        outcome: &TranscriptionOutcome,
    ) -> Result<()> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let running: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM jobs WHERE id = ?1 AND state = 'running')",
            params![job.id],
            |r| r.get(0),
        )?;
        if !running {
            return Ok(());
        }
        let now = now(&tx)?;
        match outcome {
            TranscriptionOutcome::Done {
                recognized,
                duration_ms,
            } => {
                let segments: Vec<TranscriptSegment> = recognized
                    .segments
                    .iter()
                    .filter(|s| !s.text.trim().is_empty())
                    .enumerate()
                    .map(|(i, s)| TranscriptSegment {
                        index: i as u32 + 1,
                        start_ms: s.start_ms,
                        end_ms: s.end_ms.max(s.start_ms),
                        text: s.text.trim().to_owned(),
                    })
                    .collect();
                for table in [
                    "transcript_segments",
                    "transcriptions",
                    "document_text",
                    "chunks",
                ] {
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE version_id = ?1"),
                        params![job.version_id],
                    )?;
                }
                tx.execute(
                    "INSERT INTO transcriptions (version_id, model, language, segment_count,
                         created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![
                        job.version_id,
                        job.model.map(WhisperModelId::as_str).unwrap_or("tiny"),
                        recognized.language,
                        segments.len() as u32,
                        now
                    ],
                )?;
                {
                    let mut seg = tx.prepare(
                        "INSERT INTO transcript_segments (version_id, idx, start_ms, end_ms, text)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                    )?;
                    let mut text = tx.prepare(
                        "INSERT INTO document_text (version_id, unit, text) VALUES (?1, ?2, ?3)",
                    )?;
                    for s in &segments {
                        let (start, end) = (
                            i64::try_from(s.start_ms).unwrap_or(i64::MAX),
                            i64::try_from(s.end_ms).unwrap_or(i64::MAX),
                        );
                        seg.execute(params![job.version_id, s.index, start, end, s.text])?;
                        text.execute(params![job.version_id, s.index, s.text])?;
                    }
                    let mut chunk = tx.prepare(
                        "INSERT INTO chunks (version_id, unit, ordinal, char_start, char_end, text)
                         VALUES (?1, ?2, ?3, 0, ?4, ?5)",
                    )?;
                    for (unit, ordinal, passage) in segment_passages(&segments) {
                        let len = passage.chars().count() as i64;
                        chunk.execute(params![job.version_id, unit, ordinal, len, passage])?;
                    }
                }
                let status = if segments.is_empty() {
                    TextStatus::NoText
                } else {
                    TextStatus::Extracted
                };
                tx.execute(
                    "UPDATE document_versions SET text_status = ?2,
                         duration_ms = COALESCE(duration_ms, ?3)
                     WHERE id = ?1",
                    params![
                        job.version_id,
                        status.as_str(),
                        i64::try_from(*duration_ms).unwrap_or(i64::MAX)
                    ],
                )?;
                tx.execute(
                    "UPDATE jobs SET state = 'done', progress = 100, error = NULL,
                         error_detail = NULL, updated_at = ?2
                     WHERE id = ?1",
                    params![job.id, now],
                )?;
            }
            TranscriptionOutcome::Failed { message, detail } => {
                let status = status_without_new_transcript(&tx, &job.version_id, false)?;
                tx.execute(
                    "UPDATE jobs SET state = 'failed', error = ?2, error_detail = ?3,
                         progress = NULL, updated_at = ?4
                     WHERE id = ?1",
                    params![job.id, message, detail, now],
                )?;
                tx.execute(
                    "UPDATE document_versions SET text_status = ?2 WHERE id = ?1",
                    params![job.version_id, status.as_str()],
                )?;
            }
            TranscriptionOutcome::Cancelled => {
                let status = status_without_new_transcript(&tx, &job.version_id, true)?;
                tx.execute(
                    "UPDATE jobs SET state = 'failed', error = ?2, error_detail = 'cancelled',
                         progress = NULL, updated_at = ?3
                     WHERE id = ?1",
                    params![job.id, TRANSCRIPTION_CANCELLED, now],
                )?;
                tx.execute(
                    "UPDATE document_versions SET text_status = ?2 WHERE id = ?1",
                    params![job.version_id, status.as_str()],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Path of the stored original of an audio/video version, after checking that it exists
    /// with the recorded size (the full hash was verified at import), with its media type
    /// and size. `not_found` for other kinds.
    pub fn media_blob(&self, version_id: &str) -> Result<(PathBuf, u64, String)> {
        let version = self.get_version(version_id)?;
        if !matches!(version.kind, DocumentKind::Audio | DocumentKind::Video) {
            return Err(CoreError::not_found("Il file audio/video non esiste più."));
        }
        let path = self.blobs()?.path_for(&version.sha256)?;
        let ok =
            std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() == version.size_bytes);
        if !ok {
            return Err(CoreError::Integrity {
                message: BLOB_MISSING.to_owned(),
                detail: format!("missing or resized blob {}", path.display()),
            });
        }
        Ok((path, version.size_bytes, version.media_type))
    }

    /// Claims and runs one transcription (blocking; whisper runs on a helper thread while
    /// this one stores the progress and watches for cancellation every `poll`). Returns
    /// `false` when no transcription is queued.
    pub fn run_next_transcription(
        &mut self,
        transcriber: &dyn Transcriber,
        models: &ModelManager,
        poll: Duration,
    ) -> Result<bool> {
        let Some(job) = self.claim_next_transcription()? else {
            return Ok(false);
        };
        let outcome = self.execute_transcription(&job, transcriber, models, poll);
        self.finish_transcription(&job, &outcome)?;
        Ok(true)
    }

    fn execute_transcription(
        &mut self,
        job: &ClaimedTranscription,
        transcriber: &dyn Transcriber,
        models: &ModelManager,
        poll: Duration,
    ) -> TranscriptionOutcome {
        let (Some(model), Some(language)) = (job.model, job.language) else {
            return failed(
                WHISPER_FAILED,
                "invalid model or language stored in the job",
            );
        };
        let Some(model_path) = models.installed_path(model) else {
            return failed(
                MODEL_NOT_INSTALLED,
                format!("model {} not installed", model.as_str()),
            );
        };
        let path = match self.blobs().and_then(|b| b.path_for(&job.sha256)) {
            Ok(path) => path,
            Err(err) => return failed(BLOB_MISSING, err.detail().unwrap_or_default()),
        };
        let file = match std::fs::File::open(&path) {
            Ok(file) if file.metadata().is_ok_and(|m| m.len() == job.size_bytes) => file,
            Ok(_) => return failed(BLOB_MISSING, format!("size mismatch {}", path.display())),
            Err(err) => return failed(BLOB_MISSING, format!("{}: {err}", path.display())),
        };
        let ext = extension_for(&job.media_type);
        let progress = AtomicI32::new(0);
        let abort = AtomicBool::new(false);
        let decode_progress = AtomicI32::new(0);
        let mut last_stored = -1;

        let outcome = std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let decoded = decode_to_whisper(Box::new(file), ext, &abort, |f| {
                    decode_progress.store((f * 100.0) as i32, Ordering::Relaxed);
                });
                let audio = match decoded {
                    Ok(audio) => audio,
                    Err(DecodeError::Cancelled) => return TranscriptionOutcome::Cancelled,
                    Err(DecodeError::Unsupported(d)) => return failed(CODEC_UNSUPPORTED, d),
                    Err(DecodeError::Corrupt(d)) => return failed(AUDIO_CORRUPT, d),
                    Err(DecodeError::TooLong) => return failed(TOO_LONG, "over the limit"),
                };
                let duration_ms = audio.duration_ms();
                // Less than a tenth of a second: nothing to recognise.
                if audio.samples.len() < (WHISPER_SAMPLE_RATE / 10) as usize {
                    return TranscriptionOutcome::Done {
                        recognized: Recognized {
                            language: language.as_str().replace("auto", "und"),
                            segments: Vec::new(),
                        },
                        duration_ms,
                    };
                }
                let request = TranscribeRequest {
                    model_path: &model_path,
                    samples: &audio.samples,
                    language,
                    threads: default_threads(),
                    progress: &progress,
                    abort: &abort,
                };
                match transcriber.transcribe(&request) {
                    Ok(recognized) => TranscriptionOutcome::Done {
                        recognized,
                        duration_ms,
                    },
                    Err(TranscribeError::Cancelled) => TranscriptionOutcome::Cancelled,
                    Err(TranscribeError::Model(d)) => failed(MODEL_LOAD_FAILED, d),
                    Err(TranscribeError::Failed(d)) => failed(WHISPER_FAILED, d),
                }
            });
            while !worker.is_finished() {
                std::thread::sleep(poll);
                // Decoding counts for the first 10 %, recognition for the rest.
                let decoded = decode_progress.load(Ordering::Relaxed).clamp(0, 100);
                let recognised = progress.load(Ordering::Relaxed).clamp(0, 100);
                let overall = (decoded / 10 + recognised * 9 / 10).clamp(0, 99);
                let still_running = if overall != last_stored {
                    last_stored = overall;
                    self.set_job_progress(job.id, overall as u8)
                } else {
                    self.job_is_running(job.id)
                };
                // Cancelled, deleted, or the database is unreadable: stop whisper.
                if !still_running.unwrap_or(false) {
                    abort.store(true, Ordering::SeqCst);
                }
            }
            worker.join().unwrap_or_else(|panic| {
                let detail = panic
                    .downcast_ref::<&str>()
                    .map(|s| (*s).to_owned())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "panic".to_owned());
                failed(WHISPER_FAILED, detail)
            })
        });
        outcome
    }
}

/// Timing of the transcription worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranscriberConfig {
    /// Fallback wake-up when no signal arrives.
    pub idle_poll: Duration,
    /// How often progress is stored and cancellation checked while a job runs.
    pub progress_poll: Duration,
}

impl Default for TranscriberConfig {
    fn default() -> Self {
        TranscriberConfig {
            idle_poll: Duration::from_secs(30),
            progress_poll: Duration::from_millis(300),
        }
    }
}

/// Transcription worker loop, on its own thread and SQLite connection: runs queued
/// transcriptions one at a time, calling `on_done` after each (the app wakes the embedder
/// so new passages get embedded), then sleeps until woken. Returns when every sender of
/// `wake` is dropped. On (re)opening the store it fails the transcriptions left running.
pub fn run_transcriber(
    mut open: impl FnMut() -> Result<Store>,
    wake: Receiver<()>,
    config: TranscriberConfig,
    transcriber: Arc<dyn Transcriber>,
    models: Arc<ModelManager>,
    on_done: impl Fn(),
) {
    let mut store: Option<Store> = None;
    let mut recovered = false;
    loop {
        if store.is_none() {
            match open() {
                Ok(mut opened) => {
                    if !recovered {
                        match opened.fail_interrupted_transcriptions() {
                            Ok(_) => recovered = true,
                            Err(err) => {
                                log_error("cannot recover interrupted transcriptions", &err)
                            }
                        }
                    }
                    store = Some(opened);
                }
                Err(err) => log_error("cannot open database", &err),
            }
        }
        if let Some(open_store) = store.as_mut() {
            loop {
                match open_store.run_next_transcription(
                    transcriber.as_ref(),
                    &models,
                    config.progress_poll,
                ) {
                    Ok(true) => on_done(),
                    Ok(false) => break,
                    Err(err) => {
                        log_error("transcription failed to run", &err);
                        store = None;
                        break;
                    }
                }
            }
        }
        match wake.recv_timeout(config.idle_poll) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn log_error(what: &str, err: &CoreError) {
    eprintln!(
        "localis: transcriber: {what}: {err} ({})",
        err.detail().unwrap_or("no detail")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(index: u32, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            index,
            start_ms: u64::from(index) * 1000,
            end_ms: u64::from(index) * 1000 + 900,
            text: text.to_owned(),
        }
    }

    #[test]
    fn passages_group_consecutive_segments() {
        let segments: Vec<_> = (1..=30).map(|i| seg(i, &"parola ".repeat(10))).collect();
        let passages = segment_passages(&segments);
        assert!(passages.len() >= 2);
        assert_eq!(passages[0].0, 1);
        for (unit, ordinal, text) in &passages {
            assert_eq!(*ordinal, 1);
            assert!(text.chars().count() <= CHUNK_MAX_CHARS);
            assert!(*unit >= 1);
        }
        // Every segment's text is in exactly one passage, in order.
        let joined: String = passages
            .iter()
            .map(|p| p.2.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(joined.split_whitespace().count(), 300);
        // Units are increasing first-segment indexes.
        assert!(passages.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn overlong_segment_is_split() {
        let segments = vec![
            seg(1, "breve"),
            seg(2, &"x ".repeat(CHUNK_MAX_CHARS)),
            seg(3, "fine"),
        ];
        let passages = segment_passages(&segments);
        assert_eq!(passages[0], (1, 1, "breve".to_owned()));
        assert!(passages.iter().filter(|p| p.0 == 2).count() >= 2);
        assert_eq!(passages.last().unwrap(), &(3, 1, "fine".to_owned()));
    }

    #[test]
    fn timestamps() {
        assert_eq!(format_timestamp(0), "00:00");
        assert_eq!(format_timestamp(754_900), "12:34");
        assert_eq!(format_timestamp(3_723_000), "01:02:03");
    }
}
