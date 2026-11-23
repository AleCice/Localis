//! Background jobs and the extraction worker loop. v0.5 adds transcription jobs
//! (`kind = 'transcribe'`), run by their own worker (see `transcribe.rs`): the extraction
//! queue below only ever claims `extract_text` jobs.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};

use crate::chunks::replace_chunks;
use crate::error::{CoreError, Result};
use crate::extract::{extract_guarded, ExtractError, ExtractResult};
use crate::formats::DocumentKind;
use crate::library::TextStatus;
use crate::store::{now, Store};

const JOB_NOT_FOUND: &str = "L'attività non esiste più.";
const JOB_NOT_FAILED: &str = "Si possono ripetere solo le attività non riuscite.";
/// Max jobs returned by [`Store::list_jobs`].
pub const JOBS_LIST_MAX: u32 = 200;

/// Text extraction job kind.
pub const JOB_KIND_EXTRACT_TEXT: &str = "extract_text";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobState {
    Queued,
    Running,
    Done,
    Failed,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            JobState::Queued => "queued",
            JobState::Running => "running",
            JobState::Done => "done",
            JobState::Failed => "failed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "queued" => JobState::Queued,
            "running" => JobState::Running,
            "done" => JobState::Done,
            "failed" => JobState::Failed,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: i64,
    pub document_id: String,
    pub version_id: String,
    /// [`JOB_KIND_EXTRACT_TEXT`] or `transcribe` (v0.5).
    pub kind: String,
    pub state: JobState,
    /// v0.5: 0–100 while a transcription runs; `None` when unknown.
    pub progress: Option<u8>,
    pub attempts: u32,
    /// Italian, user-facing; only when failed.
    pub error: Option<String>,
    /// Technical diagnostics; only when failed.
    pub error_detail: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A job taken by the worker (state `running`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedJob {
    pub id: i64,
    pub version_id: String,
    pub kind: DocumentKind,
    pub sha256: String,
}

const JOB_SELECT: &str = "SELECT j.id, v.document_id, j.version_id, j.kind, j.state, j.attempts,
        j.error, j.error_detail, j.created_at, j.updated_at, j.progress
    FROM jobs j JOIN document_versions v ON v.id = j.version_id";

fn row_to_job(row: &Row<'_>) -> rusqlite::Result<Job> {
    let state: String = row.get(4)?;
    Ok(Job {
        id: row.get(0)?,
        document_id: row.get(1)?,
        version_id: row.get(2)?,
        kind: row.get(3)?,
        state: JobState::parse(&state).ok_or_else(|| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                format!("unexpected job state {state:?}").into(),
            )
        })?,
        attempts: row.get(5)?,
        error: row.get(6)?,
        error_detail: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        progress: row
            .get::<_, Option<i64>>(10)?
            .map(|p| p.clamp(0, 100) as u8),
    })
}

impl Store {
    /// Jobs of the project's documents, most recent first (at most [`JOBS_LIST_MAX`]).
    pub fn list_jobs(&self, project_id: &str) -> Result<Vec<Job>> {
        self.ensure_project(project_id)?;
        let mut stmt = self.conn.prepare(&format!(
            "{JOB_SELECT} JOIN documents d ON d.id = v.document_id
             WHERE d.project_id = ?1 ORDER BY j.id DESC LIMIT ?2"
        ))?;
        let jobs = stmt
            .query_map(params![project_id, JOBS_LIST_MAX], row_to_job)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(jobs)
    }

    pub fn get_job(&self, id: i64) -> Result<Job> {
        self.conn
            .query_row(
                &format!("{JOB_SELECT} WHERE j.id = ?1"),
                params![id],
                row_to_job,
            )
            .optional()?
            .ok_or_else(|| CoreError::not_found(JOB_NOT_FOUND))
    }

    /// Puts a failed job back in the queue (`conflict` if it is not failed).
    pub fn retry_job(&mut self, id: i64) -> Result<Job> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT state, version_id FROM jobs WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((state, version_id)) = row else {
            return Err(CoreError::not_found(JOB_NOT_FOUND));
        };
        if state != JobState::Failed.as_str() {
            return Err(CoreError::conflict(JOB_NOT_FAILED));
        }
        let now = now(&tx)?;
        tx.execute(
            "UPDATE jobs SET state = 'queued', error = NULL, error_detail = NULL,
                 progress = NULL, updated_at = ?2
             WHERE id = ?1",
            params![id, now],
        )?;
        tx.execute(
            "UPDATE document_versions SET text_status = 'pending' WHERE id = ?1",
            params![version_id],
        )?;
        tx.commit()?;
        self.get_job(id)
    }

    /// Puts back in the queue the jobs left `running` by an interrupted run. Call once
    /// when the worker starts, before it claims anything.
    pub fn requeue_interrupted_jobs(&mut self) -> Result<usize> {
        let now = now(&self.conn)?;
        Ok(self.conn.execute(
            "UPDATE jobs SET state = 'queued', updated_at = ?1
             WHERE state = 'running' AND kind = 'extract_text'",
            params![now],
        )?)
    }

    /// Atomically takes the oldest queued job (queued → running, attempts + 1).
    pub fn claim_next_job(&mut self) -> Result<Option<ClaimedJob>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(i64, String, String, String)> = tx
            .query_row(
                "SELECT j.id, j.version_id, v.kind, v.sha256
                 FROM jobs j JOIN document_versions v ON v.id = j.version_id
                 WHERE j.state = 'queued' AND j.kind = 'extract_text'
                 ORDER BY j.id LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((id, version_id, kind, sha256)) = row else {
            return Ok(None);
        };
        let kind = DocumentKind::parse(&kind)
            .ok_or_else(|| CoreError::Internal(format!("unexpected document kind {kind:?}")))?;
        let now = now(&tx)?;
        tx.execute(
            "UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = ?2
             WHERE id = ?1 AND state = 'queued'",
            params![id, now],
        )?;
        tx.commit()?;
        Ok(Some(ClaimedJob {
            id,
            version_id,
            kind,
            sha256,
        }))
    }

    /// Records the result of a claimed job: text, version status and job state in one
    /// transaction. If the job is gone (document deleted meanwhile) or no longer
    /// running, the result is discarded.
    pub fn finish_job(&mut self, job: &ClaimedJob, result: &ExtractResult) -> Result<()> {
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
        tx.execute(
            "DELETE FROM document_text WHERE version_id = ?1",
            params![job.version_id],
        )?;
        match result {
            Ok(extracted) => {
                {
                    let mut insert = tx.prepare(
                        "INSERT INTO document_text (version_id, unit, text) VALUES (?1, ?2, ?3)",
                    )?;
                    for (unit, text) in &extracted.units {
                        insert.execute(params![job.version_id, unit, text])?;
                    }
                }
                // Passages for chat retrieval, in the same transaction as the text.
                replace_chunks(&tx, &job.version_id, &extracted.units)?;
                let status = if extracted.units.is_empty() {
                    TextStatus::NoText
                } else {
                    TextStatus::Extracted
                };
                tx.execute(
                    "UPDATE document_versions
                     SET text_status = ?2, page_count = COALESCE(?3, page_count)
                     WHERE id = ?1",
                    params![job.version_id, status.as_str(), extracted.page_count],
                )?;
                tx.execute(
                    "UPDATE jobs SET state = 'done', error = NULL, error_detail = NULL,
                         updated_at = ?2
                     WHERE id = ?1",
                    params![job.id, now],
                )?;
            }
            Err(err) => {
                tx.execute(
                    "DELETE FROM chunks WHERE version_id = ?1",
                    params![job.version_id],
                )?;
                tx.execute(
                    "UPDATE document_versions SET text_status = 'failed' WHERE id = ?1",
                    params![job.version_id],
                )?;
                tx.execute(
                    "UPDATE jobs SET state = 'failed', error = ?2, error_detail = ?3,
                         updated_at = ?4
                     WHERE id = ?1",
                    params![job.id, err.message, err.detail, now],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Claims and runs one job. Returns `false` when the queue is empty.
    pub fn run_next_job(&mut self, extract_timeout: Duration) -> Result<bool> {
        let Some(job) = self.claim_next_job()? else {
            return Ok(false);
        };
        let result = match self.blobs().and_then(|b| b.read_verified(&job.sha256)) {
            Ok(bytes) => extract_guarded(job.kind, Arc::new(bytes), extract_timeout),
            Err(err) => Err(ExtractError {
                message: err.to_string(),
                detail: err.detail().unwrap_or_default().to_owned(),
            }),
        };
        self.finish_job(&job, &result)?;
        Ok(true)
    }
}

/// Timing of the background worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerConfig {
    /// Fallback wake-up when no signal arrives (also retries a failed database open).
    pub poll_interval: Duration,
    /// Max time for one extraction before the job fails.
    pub extract_timeout: Duration,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        WorkerConfig {
            poll_interval: Duration::from_secs(30),
            extract_timeout: Duration::from_secs(300),
        }
    }
}

/// Worker loop: runs queued jobs one at a time on its own connection, then sleeps until
/// woken through `wake` or `poll_interval` elapses. Returns when every sender of `wake`
/// is dropped. On startup (and after any storage error) it reopens the store and
/// requeues jobs left `running`, since this loop is the only job runner, and creates the
/// passages of text extracted by older versions ([`Store::backfill_chunks`]).
pub fn run_worker(
    mut open: impl FnMut() -> Result<Store>,
    wake: Receiver<()>,
    config: WorkerConfig,
) {
    let mut store: Option<Store> = None;
    loop {
        if store.is_none() {
            match open() {
                Ok(mut opened) => match opened.requeue_interrupted_jobs() {
                    Ok(_) => {
                        // Passages for text extracted before 0.3 (idempotent).
                        if let Err(err) = opened.backfill_chunks() {
                            log_error("cannot create passages for existing text", &err);
                        }
                        store = Some(opened)
                    }
                    Err(err) => log_error("cannot requeue interrupted jobs", &err),
                },
                Err(err) => log_error("cannot open database", &err),
            }
        }
        if let Some(open_store) = store.as_mut() {
            loop {
                match open_store.run_next_job(config.extract_timeout) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(err) => {
                        log_error("job failed to run", &err);
                        store = None;
                        break;
                    }
                }
            }
        }
        match wake.recv_timeout(config.poll_interval) {
            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

fn log_error(what: &str, err: &CoreError) {
    eprintln!(
        "localis: worker: {what}: {err} ({})",
        err.detail().unwrap_or("no detail")
    );
}
