//! Confirmation of cloud sends. `prepare_cloud_send` builds the exact request for a
//! question and keeps it in memory under a single-use token (10 minutes), bound to the
//! conversation, the question, the document selection and the chosen model.
//! `send_message` with a cloud route needs that token and sends exactly the stored request.
//! Nothing is persisted until the user confirms.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::chat::Prepared;
use crate::keys::Keys;
use crate::prices::Money;
use crate::prism::RouteDecision;
use crate::providers::{Endpoints, ModelRef};
use crate::retrieval::Via;
use crate::search::UnitKind;

/// How long a prepared cloud request stays valid.
pub const CLOUD_TOKEN_TTL: Duration = Duration::from_secs(600);
/// Max prepared requests kept at once (the oldest are dropped).
const PENDING_MAX: usize = 64;

pub const TOKEN_INVALID: &str =
    "Conferma non valida o scaduta: rivedi l'anteprima e conferma di nuovo l'invio al cloud.";
pub const TOKEN_MISMATCH: &str =
    "La conferma non corrisponde a questa domanda: rivedi l'anteprima e conferma di nuovo.";
pub const ROUTE_CHANGED: &str =
    "La scelta del modello è cambiata dopo l'anteprima: rivedi l'anteprima e conferma di nuovo.";
pub const CONFIRMATION_REQUIRED: &str =
    "Questa domanda va a un modello cloud: serve la tua conferma prima dell'invio.";
pub const PROJECT_LOCAL_ONLY: &str =
    "Questo progetto è «Solo locale»: nessun dato può essere inviato a un provider cloud.";

/// Keys and endpoints, shared by the commands and the embedder.
#[derive(Clone)]
pub struct CloudEnv {
    pub keys: Keys,
    pub endpoints: Endpoints,
}

impl std::fmt::Debug for CloudEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudEnv")
            .field("endpoints", &self.endpoints)
            .finish_non_exhaustive()
    }
}

/// A prepared request waiting for confirmation.
pub(crate) struct PendingSend {
    pub conversation_id: String,
    pub text: String,
    pub document_ids: Vec<String>,
    pub route: RouteDecision,
    pub prepared: Prepared,
    created: Instant,
}

impl PendingSend {
    pub(crate) fn new(
        conversation_id: &str,
        text: &str,
        document_ids: &[String],
        route: RouteDecision,
        prepared: Prepared,
    ) -> Self {
        PendingSend {
            conversation_id: conversation_id.to_owned(),
            text: text.to_owned(),
            document_ids: normalize_ids(document_ids),
            route,
            prepared,
            created: Instant::now(),
        }
    }

    pub(crate) fn matches(
        &self,
        conversation_id: &str,
        text: &str,
        document_ids: &[String],
    ) -> bool {
        self.conversation_id == conversation_id
            && self.text == text
            && self.document_ids == normalize_ids(document_ids)
    }
}

/// Selection as a set: order and duplicates do not change the binding.
fn normalize_ids(ids: &[String]) -> Vec<String> {
    let mut v = ids.to_vec();
    v.sort();
    v.dedup();
    v
}

/// Cloud state of the running app: keychain, endpoints and prepared requests.
pub struct CloudRuntime {
    pub env: CloudEnv,
    pending: Mutex<HashMap<String, PendingSend>>,
    ttl: Duration,
}

impl CloudRuntime {
    pub fn new(keys: Keys, endpoints: Endpoints) -> Self {
        CloudRuntime {
            env: CloudEnv { keys, endpoints },
            pending: Mutex::new(HashMap::new()),
            ttl: CLOUD_TOKEN_TTL,
        }
    }

    /// Shorter validity (tests).
    pub fn with_ttl(mut self, ttl: Duration) -> Self {
        self.ttl = ttl;
        self
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    pub fn keys(&self) -> &Keys {
        &self.env.keys
    }

    pub fn endpoints(&self) -> &Endpoints {
        &self.env.endpoints
    }

    /// Stores a prepared request; returns its token (UUID v4: 122 random bits).
    pub(crate) fn put(&self, send: PendingSend) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        if let Ok(mut map) = self.pending.lock() {
            let ttl = self.ttl;
            map.retain(|_, p| p.created.elapsed() < ttl);
            while map.len() >= PENDING_MAX {
                let oldest = map
                    .iter()
                    .min_by_key(|(_, p)| p.created)
                    .map(|(k, _)| k.clone());
                match oldest {
                    Some(k) => map.remove(&k),
                    None => break,
                };
            }
            map.insert(token.clone(), send);
        }
        token
    }

    /// Removes and returns the request for `token` if it exists and has not expired.
    /// A token is consumed by its first use, valid or not.
    pub(crate) fn take(&self, token: &str) -> Option<PendingSend> {
        let send = self.pending.lock().ok()?.remove(token)?;
        (send.created.elapsed() < self.ttl).then_some(send)
    }

    /// Drops a prepared request the user did not confirm (no-op when unknown).
    pub fn discard(&self, token: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(token);
        }
    }

    /// Prepared requests currently held (including expired ones not yet dropped).
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// One source as it will be sent (`CloudPreview.sources`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreviewSource {
    pub n: u32,
    pub title: String,
    pub unit: u32,
    pub unit_kind: UnitKind,
    pub chars: u64,
    pub via: Via,
    /// v0.5: start of a transcript passage.
    pub start_ms: Option<u64>,
}

/// What will be sent, shown before the user confirms (`CloudPreview`).
#[derive(Debug, Clone, PartialEq)]
pub struct CloudPreview {
    pub token: String,
    pub route: RouteDecision,
    pub provider_name: String,
    pub host: String,
    pub question: String,
    pub sources: Vec<PreviewSource>,
    pub history_pairs: u32,
    pub history_chars: u64,
    pub total_chars: u64,
    pub est_input_tokens: u64,
    pub max_output_tokens: u64,
    /// (min, max) from the user's prices.
    pub est_cost: Option<(Money, Money)>,
    pub query_embedded_by: Option<ModelRef>,
    pub expires_at: String,
}

/// Result of [`list_provider_models`] (`ProviderModels` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderModels {
    pub provider: crate::providers::CloudProvider,
    pub reachable: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub models: Vec<crate::llm::ModelInfo>,
}

/// Lists a provider's models on explicit request of the user: only the key is sent, and
/// the request is logged (`list_models`). Without a key nothing is sent. Fails only when
/// the keychain cannot be read.
pub fn list_provider_models<A: crate::chat::StoreAccess>(
    db: &A,
    cloud: &CloudRuntime,
    provider: crate::providers::CloudProvider,
) -> crate::error::Result<ProviderModels> {
    use crate::mesh::ModelClient;
    let Some(key) = cloud.keys().get(provider)? else {
        return Ok(ProviderModels {
            provider,
            reachable: false,
            message: Some(crate::mesh::missing_key_message(provider)),
            detail: None,
            models: Vec::new(),
        });
    };
    let client = crate::mesh::CloudClient::new(provider, key, cloud.endpoints().clone());
    let result = client.list_models();
    drop(client);
    // Best effort: a log failure does not hide the answer.
    let _ = db.with_store(|s| {
        s.log_cloud_request(&crate::cloud_log::CloudLogEntry {
            provider,
            model: None,
            purpose: crate::cloud_log::CloudPurpose::ListModels,
            project_id: None,
            conversation_id: None,
            chars_sent: 0,
            usage: crate::prices::Usage::default(),
            cost: None,
            error: result.as_ref().err().map(|e| e.to_string()),
        })
    });
    Ok(match result {
        Ok(models) => ProviderModels {
            provider,
            reachable: true,
            message: None,
            detail: None,
            models,
        },
        Err(err) => ProviderModels {
            provider,
            reachable: false,
            message: Some(err.to_string()),
            detail: err.detail().map(str::to_owned),
            models: Vec::new(),
        },
    })
}
