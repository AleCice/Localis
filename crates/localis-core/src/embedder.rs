//! Background embedder: computes embeddings with the configured model (LM Studio or a
//! cloud provider) for the passages of current versions that have none for it, in batches,
//! on its own connection. When the provider is not reachable (or rate-limits) it reports
//! `unreachable` and retries with a growing delay, without marking any document as failed.
//!
//! With a cloud model only the passages of projects that are `cloud_allowed` and gave
//! consent are sent, one project per batch; the consent is checked again right before
//! each batch, so a revocation stops the next batch. Every cloud batch is logged.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;

use crate::cloud_log::{CloudLogEntry, CloudPurpose};
use crate::cloud_send::CloudEnv;
use crate::error::{CoreError, Result};
use crate::llm::{EMBED_BATCH_MAX, EMBED_BATCH_TIMEOUT};
use crate::mesh::client_for;
use crate::prices::{estimate_tokens, Money};
use crate::providers::{CloudPolicy, CloudProvider, ModelRef, ProviderId};
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
    /// Provider not reachable or the model failed: retried in the background.
    Unreachable,
    /// Cloud embedding configured, but the project is local-only or has not consented.
    NeedsConsent,
}

impl EmbeddingState {
    pub fn as_str(self) -> &'static str {
        match self {
            EmbeddingState::Disabled => "disabled",
            EmbeddingState::Idle => "idle",
            EmbeddingState::Running => "running",
            EmbeddingState::Unreachable => "unreachable",
            EmbeddingState::NeedsConsent => "needs_consent",
        }
    }
}

/// What the embedder thread last did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedderSnapshot {
    pub state: EmbeddingState,
    /// Embedding key (`provider:model`).
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
    pub provider: Option<ProviderId>,
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

/// `CloudEmbeddingEstimate` in `src/api/types.ts`.
#[derive(Debug, Clone, PartialEq)]
pub struct CloudEmbeddingEstimate {
    pub provider: CloudProvider,
    pub model: String,
    pub chunks: u64,
    pub chars: u64,
    pub est_tokens: u64,
    pub est_cost: Option<Money>,
}

/// Passages to embed: (chunk id, text).
pub type PendingBatch = Vec<(i64, String)>;

const CURRENT_VERSION_SQL: &str =
    "v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                                   WHERE m.document_id = v.document_id)";

impl Store {
    /// Passages of current versions without an embedding for `model` (an embedding key,
    /// `provider:model`), oldest first, in every project.
    pub fn pending_embeddings(&self, model: &str, limit: usize) -> Result<Vec<(i64, String)>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT c.id, c.text FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             WHERE {CURRENT_VERSION_SQL}
               AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e
                               WHERE e.chunk_id = c.id AND e.model = ?1)
             ORDER BY c.id LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![model, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Like [`Store::pending_embeddings`], limited to the projects that may send passages
    /// to a cloud provider (`cloud_allowed` + consent) and to one project per batch.
    pub fn pending_cloud_embeddings(
        &self,
        model: &str,
        limit: usize,
    ) -> Result<Option<(String, PendingBatch)>> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT d.project_id, c.id, c.text FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             JOIN projects p ON p.id = d.project_id
             WHERE p.cloud_policy = 'cloud_allowed' AND p.cloud_embedding_consent = 1
               AND {CURRENT_VERSION_SQL}
               AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e
                               WHERE e.chunk_id = c.id AND e.model = ?1)
             ORDER BY d.project_id, c.id LIMIT ?2"
        ))?;
        let rows: Vec<(String, i64, String)> = stmt
            .query_map(params![model, limit as i64], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let Some(project) = rows.first().map(|r| r.0.clone()) else {
            return Ok(None);
        };
        let batch = rows
            .into_iter()
            .filter(|r| r.0 == project)
            .map(|(_, id, text)| (id, text))
            .collect();
        Ok(Some((project, batch)))
    }

    /// Whether the project currently allows sending its passages to a cloud embedding model.
    pub fn allows_cloud_embedding(&self, project_id: &str) -> Result<bool> {
        let p = self.get_project(project_id)?;
        Ok(p.cloud_policy == CloudPolicy::CloudAllowed && p.cloud_embedding_consent)
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

    /// What indexing the project with the configured cloud embedding model would send:
    /// passages of current versions not yet embedded with it. `None` when the configured
    /// embedding model is not a cloud model.
    pub fn estimate_cloud_embedding(
        &self,
        project_id: &str,
    ) -> Result<Option<CloudEmbeddingEstimate>> {
        self.ensure_project(project_id)?;
        let Some(model) = self.llm_settings()?.embedding_model else {
            return Ok(None);
        };
        let Some(provider) = model.provider.cloud() else {
            return Ok(None);
        };
        let (chunks, chars): (i64, i64) = self.conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(c.text)), 0)
             FROM chunks c
             JOIN document_versions v ON v.id = c.version_id
             JOIN documents d ON d.id = v.document_id
             WHERE d.project_id = ?1
               AND v.version_no = (SELECT MAX(m.version_no) FROM document_versions m
                                   WHERE m.document_id = d.id)
               AND NOT EXISTS (SELECT 1 FROM chunk_embeddings e
                               WHERE e.chunk_id = c.id AND e.model = ?2)",
            params![project_id, model.embedding_key()],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let chars = chars.max(0) as u64;
        let est_tokens = estimate_tokens(chars);
        let est_cost = self.price_of(&model)?.map(|p| p.cost(est_tokens, 0));
        Ok(Some(CloudEmbeddingEstimate {
            provider,
            model: model.model,
            chunks: chunks.max(0) as u64,
            chars,
            est_tokens,
            est_cost,
        }))
    }

    /// Embedding progress of the project, combined with what the embedder last reported.
    pub fn embedding_status(
        &self,
        project_id: &str,
        shared: &EmbedderShared,
    ) -> Result<EmbeddingStatus> {
        let project = self.get_project(project_id)?;
        let model = self.llm_settings()?.embedding_model;
        let key = model.as_ref().map(ModelRef::embedding_key);
        let (total, embedded) = self.embedding_counts(project_id, key.as_deref())?;
        let (Some(model), Some(key)) = (model, key) else {
            return Ok(EmbeddingStatus {
                state: EmbeddingState::Disabled,
                provider: None,
                model: None,
                total,
                embedded: 0,
                message: None,
            });
        };
        if let Some(provider) = model.provider.cloud() {
            let allowed = project.cloud_policy == CloudPolicy::CloudAllowed
                && project.cloud_embedding_consent;
            if !allowed {
                let message = if project.cloud_policy == CloudPolicy::LocalOnly {
                    format!(
                        "Progetto «Solo locale»: i passaggi non vengono inviati a {} e la ricerca resta lessicale.",
                        provider.name()
                    )
                } else {
                    format!(
                        "Per l'indicizzazione con {} serve il tuo consenso per questo progetto; finché non lo dai la ricerca resta lessicale.",
                        provider.name()
                    )
                };
                return Ok(EmbeddingStatus {
                    state: EmbeddingState::NeedsConsent,
                    provider: Some(model.provider),
                    model: Some(model.model),
                    total,
                    embedded,
                    message: Some(message),
                });
            }
        }
        let snap = shared.snapshot();
        let (state, message) = if snap.state == EmbeddingState::Unreachable
            && snap.model.as_deref() == Some(key.as_str())
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
            provider: Some(model.provider),
            model: Some(model.model),
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
fn step(
    store: &mut Store,
    shared: &EmbedderShared,
    config: &EmbedderConfig,
    cloud: &CloudEnv,
) -> Result<Step> {
    let settings = store.llm_settings()?;
    let Some(model) = settings.embedding_model else {
        return Ok(Step::Disabled);
    };
    let key = model.embedding_key();
    let cloud_provider = model.provider.cloud();
    let batch_max = cloud_provider.map_or(EMBED_BATCH_MAX, CloudProvider::embed_batch_max);
    let limit = config.batch_size.clamp(1, batch_max);
    let (project, batch) = match cloud_provider {
        None => (None, store.pending_embeddings(&key, limit)?),
        Some(_) => match store.pending_cloud_embeddings(&key, limit)? {
            Some((project, batch)) => (Some(project), batch),
            None => (None, Vec::new()),
        },
    };
    if batch.is_empty() {
        return Ok(Step::Idle(key));
    }
    let current = shared.snapshot();
    shared.set(EmbedderSnapshot {
        state: EmbeddingState::Running,
        model: Some(key.clone()),
        // Keep the last failure visible while retrying, until a batch succeeds.
        ..if current.state == EmbeddingState::Unreachable && current.model.as_ref() == Some(&key) {
            current
        } else {
            EmbedderSnapshot::default()
        }
    });
    let client = client_for(&model, &settings.base_url, &cloud.keys, &cloud.endpoints)?;
    let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
    if let (Some(provider), Some(project)) = (cloud_provider, &project) {
        // Last check right before sending: consent revoked or project made local-only.
        if !store.allows_cloud_embedding(project)? {
            return Ok(Step::Embedded);
        }
        let result = client.embed(&model.model, &texts, config.batch_timeout);
        let usage = result.as_ref().map(|(_, u)| *u).unwrap_or_default();
        let cost = store
            .price_of(&model)?
            .and_then(|p| p.cost_of(&usage, false));
        let entry = CloudLogEntry {
            provider,
            model: Some(model.model.clone()),
            purpose: CloudPurpose::IndexEmbedding,
            project_id: Some(project.clone()),
            conversation_id: None,
            chars_sent: texts.iter().map(|t| t.chars().count() as u64).sum(),
            usage,
            cost,
            error: result.as_ref().err().map(|e| e.to_string()),
        };
        // Save the (already paid for) vectors before logging, so a log write failure can
        // never cause the batch to be sent again.
        let saved = match result {
            Ok((vectors, _)) => {
                let items: Vec<(i64, Vec<f32>)> =
                    batch.iter().map(|(id, _)| *id).zip(vectors).collect();
                store.save_embeddings(&key, &items)
            }
            Err(err) => Err(err),
        };
        if let Err(err) = store.log_cloud_request(&entry) {
            eprintln!("localis: cloud log write failed: {err}");
        }
        saved?;
        return Ok(Step::Embedded);
    }
    let (vectors, _) = client.embed(&model.model, &texts, config.batch_timeout)?;
    let items: Vec<(i64, Vec<f32>)> = batch.iter().map(|(id, _)| *id).zip(vectors).collect();
    store.save_embeddings(&key, &items)?;
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
    cloud: CloudEnv,
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
        let wait = match store.as_mut().map(|s| step(s, &shared, &config, &cloud)) {
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
            Some(Err(
                err @ (CoreError::LlmUnavailable { .. }
                | CoreError::Validation { .. }
                | CoreError::KeyringUnavailable { .. }),
            )) => {
                let delay = next_backoff(backoff, &config);
                backoff = Some(delay);
                let model = store
                    .as_ref()
                    .and_then(|s| s.llm_settings().ok())
                    .and_then(|s| s.embedding_model)
                    .map(|m| m.embedding_key());
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
