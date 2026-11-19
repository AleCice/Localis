//! Background embedder: computes embeddings with LM Studio for the passages of current
//! versions that have none for the configured model, in batches, on its own connection.
//! When LM Studio is not reachable it reports `unreachable` and retries with a growing
//! delay, without marking any document as failed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;

use crate::error::{CoreError, Result};
use crate::llm::{LlmClient, EMBED_BATCH_MAX, EMBED_BATCH_TIMEOUT};
use crate::retrieval::encode_vector;
use crate::store::Store;

const NOT_RUNNING: &str = "L'indicizzazione semantica non è attiva.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddingState {
    /// No embedding model configured.
    Disabled,
    /// Every current passage has an embedding for the configured model.
    Idle,
    Running,
    /// LM Studio not reachable or the model failed: retried in the background.
    Unreachable,
}

impl EmbeddingState {
    pub fn as_str(self) -> &'static str {
        match self {
            EmbeddingState::Disabled => "disabled",
            EmbeddingState::Idle => "idle",
            EmbeddingState::Running => "running",
            EmbeddingState::Unreachable => "unreachable",
        }
    }
}

/// What the embedder thread last did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedderSnapshot {
    pub state: EmbeddingState,
    pub model: Option<String>,
    pub message: Option<String>,
    pub detail: Option<String>,
    /// Delay before the next attempt while unreachable.
    pub retry_in: Option<Duration>,
}

impl Default for EmbedderSnapshot {
    fn default() -> Self {
        EmbedderSnapshot {
            state: EmbeddingState::Disabled,
            model: None,
            message: None,
            detail: None,
            retry_in: None,
        }
    }
}

/// State shared between the embedder thread and the commands.
#[derive(Debug, Default)]
pub struct EmbedderShared {
    snapshot: Mutex<EmbedderSnapshot>,
    alive: AtomicBool,
}

impl EmbedderShared {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn snapshot(&self) -> EmbedderSnapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Whether the embedder thread is running.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn set(&self, snapshot: EmbedderSnapshot) {
        if let Ok(mut s) = self.snapshot.lock() {
            *s = snapshot;
        }
    }
}

/// `EmbeddingStatus` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbeddingStatus {
    pub state: EmbeddingState,
    pub model: Option<String>,
    pub total: u64,
    pub embedded: u64,
    pub message: Option<String>,
}

/// Timing of the embedder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EmbedderConfig {
    pub batch_size: usize,
    /// Check for new passages this often when there is nothing to do.
    pub idle_poll: Duration,
    pub initial_backoff: Duration,
    pub max_backoff: Duration,
    pub batch_timeout: Duration,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        EmbedderConfig {
            batch_size: EMBED_BATCH_MAX,
            idle_poll: Duration::from_secs(5),
            initial_backoff: Duration::from_secs(30),
            max_backoff: Duration::from_secs(300),
            batch_timeout: EMBED_BATCH_TIMEOUT,
        }
    }
}

/// Next retry delay: `initial` first, then doubling up to `max`.
pub fn next_backoff(current: Option<Duration>, config: &EmbedderConfig) -> Duration {
    match current {
        None => config.initial_backoff,
        Some(d) => (d * 2).min(config.max_backoff),
    }
}

impl Store {
    /// Passages of current versions without an embedding for `model` (oldest first).
    pub fn pending_embeddings(&self, model: &str, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(
            "SELECT c.id, c.text FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             WHERE v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                                   WHERE m.document_id = v.document_id)
               AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e
                               WHERE e.chunk_id = c.id AND e.model = ?1)
             ORDER BY c.id LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![model, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stores embeddings (L2-normalized) for passages that still exist.
    pub fn save_embeddings(&mut self, model: &str, items: &[(i64, Vec<f32>)]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let mut saved = 0;
        {
            let mut insert = tx.prepare(
                "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, model, dim, vector)
                 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM chunks WHERE id = ?1)",
            )?;
            for (chunk_id, vector) in items {
                if vector.is_empty() {
                    continue;
                }
                saved += insert.execute(params![
                    chunk_id,
                    model,
                    vector.len() as i64,
                    encode_vector(vector)
                ])?;
            }
        }
        tx.commit()?;
        Ok(saved)
    }

    /// (total, embedded with `model`) passages of the project's current versions.
    pub fn embedding_counts(&self, project_id: &str, model: Option<&str>) -> Result<(u64, u64)> {
        self.ensure_project(project_id)?;
        let (total, embedded): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(EXISTS (SELECT 1 FROM chunk_embeddings e
                                         WHERE e.chunk_id = c.id AND e.model = ?2)), 0)
             FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE d.project_id = ?1
               AND v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                                   WHERE m.document_id = d.id)",
            params![project_id, model],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok((total.max(0) as u64, embedded.max(0) as u64))
    }

    /// Embedding progress of the project, combined with what the embedder last reported.
    pub fn embedding_status(
        &self,
        project_id: &str,
        shared: &EmbedderShared,
    ) -> Result<EmbeddingStatus> {
        let model = self.llm_settings()?.embedding_model;
        let (total, embedded) = self.embedding_counts(project_id, model.as_deref())?;
        let Some(model) = model else {
            return Ok(EmbeddingStatus {
                state: EmbeddingState::Disabled,
                model: None,
                total,
                embedded: 0,
                message: None,
            });
        };
        let snap = shared.snapshot();
        let (state, message) = if snap.state == EmbeddingState::Unreachable
            && snap.model.as_deref() == Some(model.as_str())
        {
            (EmbeddingState::Unreachable, snap.message)
        } else if embedded >= total {
            (EmbeddingState::Idle, None)
        } else if shared.is_alive() {
            (EmbeddingState::Running, None)
        } else {
            (EmbeddingState::Unreachable, Some(NOT_RUNNING.to_owned()))
        };
        Ok(EmbeddingStatus {
            state,
            model: Some(model),
            total,
            embedded,
            message,
        })
    }
}

enum Step {
    Disabled,
    Idle(String),
    Embedded,
}

/// One unit of work: embeds the next batch for the configured model.
fn step(store: &mut Store, shared: &EmbedderShared, config: &EmbedderConfig) -> Result<Step> {
    let settings = store.llm_settings()?;
    let Some(model) = settings.embedding_model else {
        return Ok(Step::Disabled);
    };
    let batch = store.pending_embeddings(&model, config.batch_size.clamp(1, EMBED_BATCH_MAX))?;
    if batch.is_empty() {
        return Ok(Step::Idle(model));
    }
    let current = shared.snapshot();
    shared.set(EmbedderSnapshot {
        state: EmbeddingState::Running,
        model: Some(model.clone()),
        // Keep the last failure visible while retrying, until a batch succeeds.
        ..if current.state == EmbeddingState::Unreachable && current.model.as_ref() == Some(&model)
        {
            current
        } else {
            EmbedderSnapshot::default()
        }
    });
    let client = LlmClient::new(&settings.base_url)?;
    let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
    let vectors = client.embed(&model, &texts, config.batch_timeout)?;
    let items: Vec<(i64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vectors).collect();
    store.save_embeddings(&model, &items)?;
    Ok(Step::Embedded)
}

/// Embedder loop on its own connection. Sleeps `idle_poll` when there is nothing to do,
/// backs off while LM Studio fails, and wakes early on a signal through `wake` (e.g.
/// settings changed: the backoff restarts). Returns when every sender of `wake` is dropped.
pub fn run_embedder(
    mut open: impl FnMut() -> Result<Store>,
    wake: Receiver<()>,
    shared: Arc<EmbedderShared>,
    config: EmbedderConfig,
) {
    shared.alive.store(true, Ordering::SeqCst);
    let _alive = AliveGuard(Arc::clone(&shared));
    let mut store: Option<Store> = None;
    let mut backoff: Option<Duration> = None;
    loop {
        if store.is_none() {
            match open() {
                Ok(s) => store = Some(s),
                Err(err) => log_error("cannot open database", &err),
            }
        }
        let wait = match store.as_mut().map(|s| step(s, &shared, &config)) {
            None => config.idle_poll,
            Some(Ok(Step::Disabled)) => {
                backoff = None;
                shared.set(EmbedderSnapshot::default());
                config.idle_poll
            }
            Some(Ok(Step::Idle(model))) => {
                backoff = None;
                shared.set(EmbedderSnapshot {
                    state: EmbeddingState::Idle,
                    model: Some(model),
                    ..EmbedderSnapshot::default()
                });
                config.idle_poll
            }
            Some(Ok(Step::Embedded)) => {
                backoff = None;
                let snap = shared.snapshot();
                shared.set(EmbedderSnapshot {
                    state: EmbeddingState::Running,
                    model: snap.model,
                    ..EmbedderSnapshot::default()
                });
                Duration::ZERO
            }
            Some(Err(err @ (CoreError::LlmUnavailable { .. } | CoreError::Validation { .. }))) => {
                let delay = next_backoff(backoff, &config);
                backoff = Some(delay);
                let model = store
                    .as_ref()
                    .and_then(|s| s.llm_settings().ok())
                    .and_then(|s| s.embedding_model);
                shared.set(EmbedderSnapshot {
                    state: EmbeddingState::Unreachable,
                    model,
                    message: Some(err.to_string()),
                    detail: err.detail().map(str::to_owned),
                    retry_in: Some(delay),
                });
                delay
            }
            Some(Err(err)) => {
                log_error("embedding step failed", &err);
                store = None;
                config.idle_poll
            }
        };
        if wait.is_zero() {
            match wake.try_recv() {
                Ok(()) | Err(TryRecvError::Empty) => continue,
                Err(TryRecvError::Disconnected) => return,
            }
        }
        match wake.recv_timeout(wait) {
            Ok(()) => backoff = None,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

struct AliveGuard(Arc<EmbedderShared>);

impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.alive.store(false, Ordering::SeqCst);
    }
}

fn log_error(what: &str, err: &CoreError) {
    eprintln!(
        "localis: embedder: {what}: {err} ({})",
        err.detail().unwrap_or("no detail")
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_max() {
        let config = EmbedderConfig::default();
        let mut d = None;
        let mut seen = Vec::new();
        for _ in 0..6 {
            let next = next_backoff(d, &config);
            seen.push(next.as_secs());
            d = Some(next);
        }
        assert_eq!(seen, [30, 60, 120, 240, 300, 300]);
    }
}
