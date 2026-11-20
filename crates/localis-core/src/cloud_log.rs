//! Local log of every request sent to a cloud provider (`cloud_requests`): provider,
//! model, purpose, project/conversation, characters sent, usage, cost and outcome.
//! Never the content sent, never the key.

use rusqlite::params;

use crate::error::Result;
use crate::prices::{Money, Usage};
use crate::providers::CloudProvider;
use crate::store::{now, Store};

/// Max entries returned by [`Store::list_cloud_requests`].
pub const CLOUD_LOG_MAX: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloudPurpose {
    Chat,
    QueryEmbedding,
    IndexEmbedding,
    ListModels,
}

impl CloudPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            CloudPurpose::Chat => "chat",
            CloudPurpose::QueryEmbedding => "query_embedding",
            CloudPurpose::IndexEmbedding => "index_embedding",
            CloudPurpose::ListModels => "list_models",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "chat" => CloudPurpose::Chat,
            "query_embedding" => CloudPurpose::QueryEmbedding,
            "index_embedding" => CloudPurpose::IndexEmbedding,
            "list_models" => CloudPurpose::ListModels,
            _ => return None,
        })
    }
}

/// One logged request (`CloudRequest` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct CloudRequest {
    pub id: i64,
    pub created_at: String,
    pub provider: CloudProvider,
    pub model: Option<String>,
    pub purpose: CloudPurpose,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub chars_sent: u64,
    pub usage: Option<Usage>,
    pub cost: Option<Money>,
    pub ok: bool,
    /// Italian, user-facing message of the failure (no diagnostics, no content).
    pub error: Option<String>,
}

/// What is logged for a request (see [`Store::log_cloud_request`]).
#[derive(Debug, Clone, PartialEq)]
pub struct CloudLogEntry {
    pub provider: CloudProvider,
    pub model: Option<String>,
    pub purpose: CloudPurpose,
    pub project_id: Option<String>,
    pub conversation_id: Option<String>,
    pub chars_sent: u64,
    pub usage: Usage,
    pub cost: Option<Money>,
    pub error: Option<String>,
}

impl Store {
    pub fn log_cloud_request(&mut self, e: &CloudLogEntry) -> Result<()> {
        let now = now(&self.conn)?;
        // A project or conversation deleted meanwhile is logged without the reference.
        self.conn.execute(
            "INSERT INTO cloud_requests (created_at, provider, model, purpose, project_id,
                 conversation_id, chars_sent, input_tokens, output_tokens, cost_amount,
                 cost_currency, ok, error)
             VALUES (?1, ?2, ?3, ?4,
                 (SELECT id FROM projects WHERE id = ?5),
                 (SELECT id FROM conversations WHERE id = ?6),
                 ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                now,
                e.provider.as_str(),
                e.model,
                e.purpose.as_str(),
                e.project_id,
                e.conversation_id,
                e.chars_sent as i64,
                e.usage.input_tokens.map(|t| t as i64),
                e.usage.output_tokens.map(|t| t as i64),
                e.cost.as_ref().map(|c| c.amount),
                e.cost.as_ref().map(|c| c.currency.as_str()),
                e.error.is_none(),
                e.error
            ],
        )?;
        Ok(())
    }

    /// Most recent first, at most `limit` (clamped to 1..=[`CLOUD_LOG_MAX`]).
    pub fn list_cloud_requests(&self, limit: usize) -> Result<Vec<CloudRequest>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, created_at, provider, model, purpose, project_id, conversation_id,
                    chars_sent, input_tokens, output_tokens, cost_amount, cost_currency, ok, error
             FROM cloud_requests ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit.clamp(1, CLOUD_LOG_MAX) as i64], |r| {
            let provider: String = r.get(2)?;
            let purpose: String = r.get(4)?;
            let input: Option<i64> = r.get(8)?;
            let output: Option<i64> = r.get(9)?;
            let amount: Option<f64> = r.get(10)?;
            let currency: Option<String> = r.get(11)?;
            let usage = Usage {
                input_tokens: input.map(|t| t.max(0) as u64),
                output_tokens: output.map(|t| t.max(0) as u64),
            };
            let (Some(provider), Some(purpose)) = (
                CloudProvider::parse(&provider),
                CloudPurpose::parse(&purpose),
            ) else {
                return Ok(None);
            };
            Ok(Some(CloudRequest {
                id: r.get(0)?,
                created_at: r.get(1)?,
                provider,
                model: r.get(3)?,
                purpose,
                project_id: r.get(5)?,
                conversation_id: r.get(6)?,
                chars_sent: r.get::<_, i64>(7)?.max(0) as u64,
                usage: (!usage.is_empty()).then_some(usage),
                cost: amount
                    .zip(currency)
                    .map(|(amount, currency)| Money { amount, currency }),
                ok: r.get(12)?,
                error: r.get(13)?,
            }))
        })?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect())
    }
}
