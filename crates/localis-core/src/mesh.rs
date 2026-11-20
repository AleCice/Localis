//! Model Mesh: one interface for every model provider (LM Studio on loopback and the
//! cloud providers), so the chat pipeline, retrieval and the embedder never depend on a
//! provider's wire format. The prompt is the same for every provider.
//!
//! Cloud failures map to `llm_unavailable` with the provider's name: 401/403 → invalid
//! key, 429 → rate limit, 5xx/network → not reachable. Diagnostics go in `detail`, never
//! with the key. There is no fallback to another provider.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{CoreError, Result};
use crate::keys::{redact, Keys};
use crate::llm::{
    http_detail, normalize, parse_embeddings, parse_openai_event, run_stream, truncate, Chunk,
    LlmClient, ModelInfo, ModelKind, PromptMessage, StreamEnd, StreamRequest, SHORT_TIMEOUT,
    STREAM_READ_TIMEOUT,
};
use crate::prices::Usage;
use crate::providers::{cloud_agent, CloudProvider, Endpoints, ModelRef, ProviderId};

/// Output limit of a cloud chat request.
pub const CLOUD_MAX_OUTPUT_TOKENS: u64 = 2048;
/// Temperature of every chat request.
pub const TEMPERATURE: f64 = 0.2;
const RESPONSE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const MODEL_PAGES_MAX: usize = 20;
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// Common interface of model providers.
pub trait ModelClient: Send + Sync {
    fn provider(&self) -> ProviderId;
    fn list_models(&self) -> Result<Vec<ModelInfo>>;
    /// Streams a chat answer; text goes to `on_delta`. Returns how it ended and the usage
    /// reported by the provider (empty when not reported or cancelled).
    fn chat(
        &self,
        model: &str,
        messages: &[PromptMessage],
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(&str),
    ) -> (StreamEnd, Usage);
    /// Embeds at most [`ModelClient::embed_batch_max`] texts; vectors are L2-normalized.
    fn embed(
        &self,
        model: &str,
        texts: &[String],
        total: Duration,
    ) -> Result<(Vec<Vec<f32>>, Usage)>;
    fn embed_batch_max(&self) -> usize;
}

impl ModelClient for LlmClient {
    fn provider(&self) -> ProviderId {
        ProviderId::LmStudio
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        LlmClient::list_models(self)
    }

    fn chat(
        &self,
        model: &str,
        messages: &[PromptMessage],
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(&str),
    ) -> (StreamEnd, Usage) {
        self.chat_stream_with_usage(model, messages, cancel, on_delta)
    }

    fn embed(
        &self,
        model: &str,
        texts: &[String],
        total: Duration,
    ) -> Result<(Vec<Vec<f32>>, Usage)> {
        Ok((
            LlmClient::embed(self, model, texts, total)?,
            Usage::default(),
        ))
    }

    fn embed_batch_max(&self) -> usize {
        crate::llm::EMBED_BATCH_MAX
    }
}

/// A cloud provider with its key, bound to the fixed host (or a debug-only test override).
pub struct CloudClient {
    provider: CloudProvider,
    key: String,
    endpoints: Endpoints,
}

impl std::fmt::Debug for CloudClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the key.
        f.debug_struct("CloudClient")
            .field("provider", &self.provider)
            .finish_non_exhaustive()
    }
}

/// Message when a provider has no key in the keychain.
pub fn missing_key_message(provider: CloudProvider) -> String {
    format!(
        "Nessuna chiave API salvata per {}: aggiungila in Impostazioni → Provider cloud.",
        provider.name()
    )
}

impl CloudClient {
    pub fn new(provider: CloudProvider, key: String, endpoints: Endpoints) -> Self {
        CloudClient {
            provider,
            key,
            endpoints,
        }
    }

    /// Reads the key from the keychain: `llm_unavailable` when there is none,
    /// `keyring_unavailable` when the keychain cannot be used.
    pub fn from_keys(provider: CloudProvider, keys: &Keys, endpoints: &Endpoints) -> Result<Self> {
        match keys.get(provider)? {
            Some(key) => Ok(Self::new(provider, key, endpoints.clone())),
            None => Err(CoreError::llm(
                missing_key_message(provider),
                "no API key in the keychain",
            )),
        }
    }

    fn name(&self) -> &'static str {
        self.provider.name()
    }

    fn agent(&self, total: Option<Duration>, per_read: Option<Duration>) -> ureq::Agent {
        cloud_agent(self.endpoints.is_overridden(self.provider), total, per_read)
    }

    fn auth_headers(&self) -> Vec<(&'static str, String)> {
        match self.provider {
            CloudProvider::Anthropic => vec![
                ("x-api-key", self.key.clone()),
                ("anthropic-version", ANTHROPIC_VERSION.to_owned()),
            ],
            CloudProvider::Gemini => vec![("x-goog-api-key", self.key.clone())],
            CloudProvider::OpenAi | CloudProvider::DeepSeek | CloudProvider::Qwen => {
                vec![("Authorization", format!("Bearer {}", self.key))]
            }
        }
    }

    fn unreachable(&self, detail: String) -> CoreError {
        unreachable_error(self.provider, detail)
    }

    fn status_error(&self, status: u16, body: &str) -> CoreError {
        status_error(self.provider, status, body, &self.key)
    }

    fn bad_response(&self, status: u16, body: &str) -> CoreError {
        CoreError::llm(
            format!("{} ha restituito una risposta non valida.", self.name()),
            redact(&http_detail(status, body), &self.key),
        )
    }

    fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        total: Duration,
    ) -> Result<String> {
        let url = self.endpoints.url(self.provider, path)?;
        let agent = self.agent(Some(total), None);
        let headers = self.auth_headers();
        let result = match body {
            None => {
                let mut req = agent.get(&url);
                for (n, v) in &headers {
                    req = req.header(*n, v.as_str());
                }
                req.call()
            }
            Some(body) => {
                let bytes =
                    serde_json::to_vec(body).map_err(|e| CoreError::Internal(e.to_string()))?;
                let mut req = agent.post(&url).header("Content-Type", "application/json");
                for (n, v) in &headers {
                    req = req.header(*n, v.as_str());
                }
                req.send(&bytes[..])
            }
        };
        let mut resp = result.map_err(|e| self.unreachable(format!("{method} {url}: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(RESPONSE_MAX_BYTES)
            .read_to_string()
            .map_err(|e| self.unreachable(format!("{method} {url}: {e}")))?;
        if status != 200 {
            return Err(self.status_error(status, &text));
        }
        Ok(text)
    }

    fn openai_compatible_models(&self) -> Result<Vec<ModelInfo>> {
        let body = self.send("GET", "/models", None, SHORT_TIMEOUT)?;
        let value: Value =
            serde_json::from_str(&body).map_err(|_| self.bad_response(200, &body))?;
        let data = value
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| self.bad_response(200, &body))?;
        Ok(data
            .iter()
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .map(|id| ModelInfo {
                id: id.to_owned(),
                kind: match self.provider {
                    // DeepSeek offers chat models only.
                    CloudProvider::DeepSeek => ModelKind::Llm,
                    _ if id.contains("embedding") => ModelKind::Embedding,
                    _ => ModelKind::Unknown,
                },
                state: None,
            })
            .collect())
    }

    fn anthropic_models(&self) -> Result<Vec<ModelInfo>> {
        let mut out = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..MODEL_PAGES_MAX {
            let path = match &after {
                None => "/models?limit=1000".to_owned(),
                Some(id) => format!("/models?limit=1000&after_id={}", query_escape(id)),
            };
            let body = self.send("GET", &path, None, SHORT_TIMEOUT)?;
            let value: Value =
                serde_json::from_str(&body).map_err(|_| self.bad_response(200, &body))?;
            let data = value
                .get("data")
                .and_then(Value::as_array)
                .ok_or_else(|| self.bad_response(200, &body))?;
            for m in data {
                if let Some(id) = m.get("id").and_then(Value::as_str) {
                    // Anthropic offers chat models only.
                    out.push(ModelInfo {
                        id: id.to_owned(),
                        kind: ModelKind::Llm,
                        state: None,
                    });
                }
            }
            let more = value.get("has_more").and_then(Value::as_bool) == Some(true);
            after = value
                .get("last_id")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if !more || after.is_none() {
                break;
            }
        }
        Ok(out)
    }

    fn gemini_models(&self) -> Result<Vec<ModelInfo>> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        for _ in 0..MODEL_PAGES_MAX {
            let path = match &token {
                None => "/models?pageSize=1000".to_owned(),
                Some(t) => format!("/models?pageSize=1000&pageToken={}", query_escape(t)),
            };
            let body = self.send("GET", &path, None, SHORT_TIMEOUT)?;
            let value: Value =
                serde_json::from_str(&body).map_err(|_| self.bad_response(200, &body))?;
            let models = value
                .get("models")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for m in &models {
                let Some(name) = m.get("name").and_then(Value::as_str) else {
                    continue;
                };
                let methods: Vec<&str> = m
                    .get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_str).collect())
                    .unwrap_or_default();
                let kind = if methods
                    .iter()
                    .any(|x| *x == "embedContent" || *x == "batchEmbedContents")
                {
                    ModelKind::Embedding
                } else if methods.contains(&"generateContent") {
                    ModelKind::Llm
                } else {
                    ModelKind::Unknown
                };
                out.push(ModelInfo {
                    id: name.strip_prefix("models/").unwrap_or(name).to_owned(),
                    kind,
                    state: None,
                });
            }
            token = value
                .get("nextPageToken")
                .and_then(Value::as_str)
                .filter(|t| !t.is_empty())
                .map(str::to_owned);
            if token.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// Body of a chat request (exposed for tests of the wire format).
    pub fn chat_body(&self, model: &str, messages: &[PromptMessage]) -> Result<(String, Value)> {
        let roles = |m: &PromptMessage| json!({ "role": m.role, "content": m.content });
        Ok(match self.provider {
            CloudProvider::OpenAi => (
                "/chat/completions".to_owned(),
                json!({
                    "model": model,
                    "messages": messages.iter().map(roles).collect::<Vec<_>>(),
                    "stream": true,
                    "stream_options": { "include_usage": true },
                    "temperature": TEMPERATURE,
                    "max_completion_tokens": CLOUD_MAX_OUTPUT_TOKENS,
                }),
            ),
            CloudProvider::DeepSeek | CloudProvider::Qwen => (
                "/chat/completions".to_owned(),
                json!({
                    "model": model,
                    "messages": messages.iter().map(roles).collect::<Vec<_>>(),
                    "stream": true,
                    "stream_options": { "include_usage": true },
                    "temperature": TEMPERATURE,
                    "max_tokens": CLOUD_MAX_OUTPUT_TOKENS,
                }),
            ),
            CloudProvider::Anthropic => {
                let system = system_text(messages);
                let rest: Vec<Value> = messages
                    .iter()
                    .filter(|m| m.role != "system")
                    .map(roles)
                    .collect();
                let mut body = json!({
                    "model": model,
                    "max_tokens": CLOUD_MAX_OUTPUT_TOKENS,
                    "messages": rest,
                    "stream": true,
                    "temperature": TEMPERATURE,
                });
                if !system.is_empty() {
                    body["system"] = Value::from(system);
                }
                ("/messages".to_owned(), body)
            }
            CloudProvider::Gemini => {
                let model = gemini_model(model)?;
                let system = system_text(messages);
                let contents: Vec<Value> = messages
                    .iter()
                    .filter(|m| m.role != "system")
                    .map(|m| {
                        json!({
                            "role": if m.role == "assistant" { "model" } else { "user" },
                            "parts": [{ "text": m.content }],
                        })
                    })
                    .collect();
                let mut body = json!({
                    "contents": contents,
                    "generationConfig": {
                        "temperature": TEMPERATURE,
                        "maxOutputTokens": CLOUD_MAX_OUTPUT_TOKENS,
                    },
                });
                if !system.is_empty() {
                    body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
                }
                (
                    format!("/models/{model}:streamGenerateContent?alt=sse"),
                    body,
                )
            }
        })
    }
}

/// Text of the system messages, joined.
fn system_text(messages: &[PromptMessage]) -> String {
    messages
        .iter()
        .filter(|m| m.role == "system")
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// A Gemini model id safe to put in the URL path (`models/` prefix removed).
fn gemini_model(model: &str) -> Result<&str> {
    let id = model.strip_prefix("models/").unwrap_or(model);
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(CoreError::validation(
            "model",
            "Il nome del modello non è valido.",
        ));
    }
    Ok(id)
}

fn query_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `llm_unavailable` for a network failure or a 5xx answer.
pub(crate) fn unreachable_error(provider: CloudProvider, detail: String) -> CoreError {
    CoreError::llm(format!("{} non raggiungibile.", provider.name()), detail)
}

/// `llm_unavailable` for an HTTP error status. With 401/403 the body is not kept at all
/// (some providers echo part of the key); otherwise it is kept with the key removed.
pub(crate) fn status_error(
    provider: CloudProvider,
    status: u16,
    body: &str,
    key: &str,
) -> CoreError {
    let name = provider.name();
    match status {
        401 | 403 => CoreError::llm(
            format!("Chiave API non valida o senza permessi per {name}."),
            format!("HTTP {status}"),
        ),
        429 => CoreError::llm(
            format!("Limite di richieste raggiunto per {name}. Riprova più tardi."),
            redact(&http_detail(status, body), key),
        ),
        500..=599 => unreachable_error(provider, redact(&http_detail(status, body), key)),
        _ => CoreError::llm(
            format!("{name} ha rifiutato la richiesta."),
            redact(&http_detail(status, body), key),
        ),
    }
}

/// Whether an error is a provider's rate limit (HTTP 429).
pub fn is_rate_limited(err: &CoreError) -> bool {
    matches!(err, CoreError::LlmUnavailable { detail, .. } if detail.starts_with("HTTP 429"))
}

impl ModelClient for CloudClient {
    fn provider(&self) -> ProviderId {
        ProviderId::Cloud(self.provider)
    }

    fn list_models(&self) -> Result<Vec<ModelInfo>> {
        match self.provider {
            CloudProvider::OpenAi | CloudProvider::DeepSeek | CloudProvider::Qwen => {
                self.openai_compatible_models()
            }
            CloudProvider::Anthropic => self.anthropic_models(),
            CloudProvider::Gemini => self.gemini_models(),
        }
    }

    fn chat(
        &self,
        model: &str,
        messages: &[PromptMessage],
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(&str),
    ) -> (StreamEnd, Usage) {
        let fail = |e: CoreError| (StreamEnd::Failed(e), Usage::default());
        let (path, body) = match self.chat_body(model, messages) {
            Ok(x) => x,
            Err(e) => return fail(e),
        };
        let url = match self.endpoints.url(self.provider, &path) {
            Ok(u) => u,
            Err(e) => return fail(e),
        };
        let bytes = match serde_json::to_vec(&body) {
            Ok(b) => b,
            Err(e) => return fail(CoreError::Internal(e.to_string())),
        };
        let parse = match self.provider {
            CloudProvider::OpenAi | CloudProvider::DeepSeek | CloudProvider::Qwen => {
                parse_openai_event
            }
            CloudProvider::Anthropic => parse_anthropic_event,
            CloudProvider::Gemini => parse_gemini_event,
        };
        let provider = self.provider;
        let key = self.key.clone();
        run_stream(
            StreamRequest {
                agent: self.agent(None, Some(STREAM_READ_TIMEOUT)),
                url,
                headers: self.auth_headers(),
                body: bytes,
                parse,
                model_failed: format!(
                    "Il modello di {} non ha risposto correttamente.",
                    provider.name()
                ),
                on_status: Box::new(move |status, text| status_error(provider, status, text, &key)),
                unreachable: Box::new(move |detail| unreachable_error(provider, detail)),
            },
            cancel,
            on_delta,
        )
    }

    fn embed(
        &self,
        model: &str,
        texts: &[String],
        total: Duration,
    ) -> Result<(Vec<Vec<f32>>, Usage)> {
        if texts.is_empty() {
            return Ok((Vec::new(), Usage::default()));
        }
        if !self.provider.supports_embeddings() {
            return Err(CoreError::llm(
                format!("{} non offre modelli di embedding.", self.name()),
                "embeddings not supported",
            ));
        }
        if texts.len() > self.embed_batch_max() {
            return Err(CoreError::Internal(format!(
                "embedding batch of {} texts exceeds {}",
                texts.len(),
                self.embed_batch_max()
            )));
        }
        let failed = |body: &str| {
            CoreError::llm(
                format!(
                    "Il modello di embedding di {} non ha risposto correttamente.",
                    self.name()
                ),
                redact(&http_detail(200, body), &self.key),
            )
        };
        match self.provider {
            CloudProvider::Gemini => {
                let id = gemini_model(model)?;
                let requests: Vec<Value> = texts
                    .iter()
                    .map(|t| json!({ "model": format!("models/{id}"), "content": { "parts": [{ "text": t }] } }))
                    .collect();
                let body = self.send(
                    "POST",
                    &format!("/models/{id}:batchEmbedContents"),
                    Some(&json!({ "requests": requests })),
                    total,
                )?;
                let vectors =
                    parse_gemini_embeddings(&body, texts.len()).ok_or_else(|| failed(&body))?;
                Ok((vectors, Usage::default()))
            }
            _ => {
                let body = self.send(
                    "POST",
                    "/embeddings",
                    Some(&json!({ "model": model, "input": texts, "encoding_format": "float" })),
                    total,
                )?;
                let vectors = parse_embeddings(&body, texts.len()).ok_or_else(|| failed(&body))?;
                let usage = serde_json::from_str::<Value>(&body)
                    .ok()
                    .and_then(|v| v.pointer("/usage/prompt_tokens").and_then(Value::as_u64))
                    .map(|t| Usage {
                        input_tokens: Some(t),
                        output_tokens: None,
                    })
                    .unwrap_or_default();
                Ok((vectors, usage))
            }
        }
    }

    fn embed_batch_max(&self) -> usize {
        self.provider.embed_batch_max()
    }
}

/// Anthropic Messages stream: `message_start` (input usage), `content_block_delta`
/// (text), `message_delta` (output usage), `message_stop`, `error`.
pub(crate) fn parse_anthropic_event(data: &str) -> Vec<Chunk> {
    let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
        return vec![Chunk::Error(format!(
            "invalid stream event: {}",
            truncate(data, 200)
        ))];
    };
    let usage_of = |u: &Value| Usage {
        input_tokens: u.get("input_tokens").and_then(Value::as_u64),
        output_tokens: u.get("output_tokens").and_then(Value::as_u64),
    };
    match value.get("type").and_then(Value::as_str) {
        Some("message_start") => value
            .pointer("/message/usage")
            .map(|u| vec![Chunk::Usage(usage_of(u))])
            .unwrap_or_default(),
        Some("content_block_delta") => match value.pointer("/delta/text").and_then(Value::as_str) {
            Some(t) => vec![Chunk::Text(t.to_owned())],
            None => Vec::new(),
        },
        Some("message_delta") => value
            .get("usage")
            .map(|u| vec![Chunk::Usage(usage_of(u))])
            .unwrap_or_default(),
        Some("message_stop") => vec![Chunk::Done],
        Some("error") => vec![Chunk::Error(format!(
            "model error: {}",
            truncate(&value.get("error").unwrap_or(&Value::Null).to_string(), 300)
        ))],
        _ => Vec::new(),
    }
}

/// Gemini `streamGenerateContent?alt=sse`: each event is a partial response with text
/// parts and `usageMetadata`; the stream ends when the body ends.
pub(crate) fn parse_gemini_event(data: &str) -> Vec<Chunk> {
    let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
        return vec![Chunk::Error(format!(
            "invalid stream event: {}",
            truncate(data, 200)
        ))];
    };
    if let Some(err) = value.get("error") {
        return vec![Chunk::Error(format!(
            "model error: {}",
            truncate(&err.to_string(), 300)
        ))];
    }
    let mut out = Vec::new();
    if let Some(reason) = value
        .pointer("/promptFeedback/blockReason")
        .and_then(Value::as_str)
    {
        return vec![Chunk::Error(format!("prompt blocked: {reason}"))];
    }
    if let Some(parts) = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
    {
        let text: String = parts
            .iter()
            .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect();
        if !text.is_empty() {
            out.push(Chunk::Text(text));
        }
    }
    if let Some(u) = value.get("usageMetadata") {
        out.push(Chunk::Usage(Usage {
            input_tokens: u.get("promptTokenCount").and_then(Value::as_u64),
            output_tokens: u.get("candidatesTokenCount").and_then(Value::as_u64),
        }));
    }
    out
}

fn parse_gemini_embeddings(body: &str, expected: usize) -> Option<Vec<Vec<f32>>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let items = value.get("embeddings")?.as_array()?;
    if items.len() != expected {
        return None;
    }
    let mut out = Vec::with_capacity(expected);
    for item in items {
        let raw = item.get("values")?.as_array()?;
        let mut v = Vec::with_capacity(raw.len());
        for x in raw {
            v.push(x.as_f64()? as f32);
        }
        out.push(normalize(v)?);
    }
    let dim = out.first()?.len();
    out.iter().all(|v| v.len() == dim).then_some(out)
}

/// Opens a client for `model`: LM Studio at `base_url`, or the cloud provider with its key.
pub fn client_for(
    model: &ModelRef,
    base_url: &str,
    keys: &Keys,
    endpoints: &Endpoints,
) -> Result<Box<dyn ModelClient>> {
    Ok(match model.provider {
        ProviderId::LmStudio => Box::new(LlmClient::new(base_url)?),
        ProviderId::Cloud(p) => Box::new(CloudClient::from_keys(p, keys, endpoints)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt() -> Vec<PromptMessage> {
        vec![
            PromptMessage {
                role: "system",
                content: "S".into(),
            },
            PromptMessage {
                role: "user",
                content: "D1".into(),
            },
            PromptMessage {
                role: "assistant",
                content: "R1".into(),
            },
            PromptMessage {
                role: "user",
                content: "Q".into(),
            },
        ]
    }

    fn client(p: CloudProvider) -> CloudClient {
        CloudClient::new(p, "sk-test".into(), Endpoints::default())
    }

    #[test]
    fn wire_formats_per_provider() {
        let (path, b) = client(CloudProvider::OpenAi)
            .chat_body("gpt", &prompt())
            .unwrap();
        assert_eq!(path, "/chat/completions");
        assert_eq!(b["messages"].as_array().unwrap().len(), 4);
        assert_eq!(b["stream_options"]["include_usage"], true);
        assert_eq!(b["max_completion_tokens"], 2048);
        assert_eq!(b["temperature"], 0.2);
        let (_, b) = client(CloudProvider::DeepSeek)
            .chat_body("ds", &prompt())
            .unwrap();
        assert_eq!(b["max_tokens"], 2048);
        let (path, b) = client(CloudProvider::Anthropic)
            .chat_body("c", &prompt())
            .unwrap();
        assert_eq!(path, "/messages");
        assert_eq!(b["system"], "S");
        assert_eq!(b["max_tokens"], 2048);
        let roles: Vec<&str> = b["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "assistant", "user"]);
        let (path, b) = client(CloudProvider::Gemini)
            .chat_body("models/gemini-x", &prompt())
            .unwrap();
        assert_eq!(path, "/models/gemini-x:streamGenerateContent?alt=sse");
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], "S");
        let roles: Vec<&str> = b["contents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["role"].as_str().unwrap())
            .collect();
        assert_eq!(roles, ["user", "model", "user"]);
        assert_eq!(b["generationConfig"]["maxOutputTokens"], 2048);
        assert!(client(CloudProvider::Gemini)
            .chat_body("../evil", &prompt())
            .is_err());
        assert!(client(CloudProvider::Gemini)
            .chat_body("a:b", &prompt())
            .is_err());
    }

    #[test]
    fn auth_headers_per_provider() {
        let h = client(CloudProvider::OpenAi).auth_headers();
        assert_eq!(h, [("Authorization", "Bearer sk-test".to_owned())]);
        let h = client(CloudProvider::Anthropic).auth_headers();
        assert_eq!(h[0], ("x-api-key", "sk-test".to_owned()));
        assert_eq!(h[1], ("anthropic-version", "2023-06-01".to_owned()));
        let h = client(CloudProvider::Gemini).auth_headers();
        assert_eq!(h, [("x-goog-api-key", "sk-test".to_owned())]);
        assert!(!format!("{:?}", client(CloudProvider::OpenAi)).contains("sk-test"));
    }

    #[test]
    fn anthropic_events() {
        assert_eq!(
            parse_anthropic_event(
                r#"{"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}"#
            ),
            [Chunk::Usage(Usage {
                input_tokens: Some(25),
                output_tokens: Some(1)
            })]
        );
        assert_eq!(
            parse_anthropic_event(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ciao"}}"#
            ),
            [Chunk::Text("Ciao".into())]
        );
        assert_eq!(
            parse_anthropic_event(
                r#"{"type":"message_delta","delta":{},"usage":{"output_tokens":15}}"#
            ),
            [Chunk::Usage(Usage {
                input_tokens: None,
                output_tokens: Some(15)
            })]
        );
        assert_eq!(
            parse_anthropic_event(r#"{"type":"message_stop"}"#),
            [Chunk::Done]
        );
        assert!(parse_anthropic_event(r#"{"type":"ping"}"#).is_empty());
        assert!(matches!(
            parse_anthropic_event(r#"{"type":"error","error":{"type":"overloaded_error"}}"#)[..],
            [Chunk::Error(_)]
        ));
    }

    #[test]
    fn gemini_events_and_embeddings() {
        assert_eq!(
            parse_gemini_event(
                r#"{"candidates":[{"content":{"parts":[{"text":"Ci"},{"text":"ao"}],"role":"model"}}],
                   "usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":2}}"#
            ),
            [
                Chunk::Text("Ciao".into()),
                Chunk::Usage(Usage {
                    input_tokens: Some(9),
                    output_tokens: Some(2)
                })
            ]
        );
        assert!(matches!(
            parse_gemini_event(r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#)[..],
            [Chunk::Error(_)]
        ));
        let v = parse_gemini_embeddings(r#"{"embeddings":[{"values":[3,4]},{"values":[0,1]}]}"#, 2)
            .unwrap();
        assert_eq!(v[0], [0.6, 0.8]);
        assert!(parse_gemini_embeddings(r#"{"embeddings":[]}"#, 1).is_none());
    }

    #[test]
    fn status_errors_name_the_provider_and_never_carry_the_key() {
        let key = "sk-SENTINEL-123456";
        let body = format!(r#"{{"error":"Incorrect API key provided: {key}"}}"#);
        for (status, needle) in [
            (401, "Chiave API non valida o senza permessi per OpenAI."),
            (403, "Chiave API non valida o senza permessi per OpenAI."),
            (429, "Limite di richieste raggiunto per OpenAI."),
            (500, "OpenAI non raggiungibile."),
            (503, "OpenAI non raggiungibile."),
            (400, "OpenAI ha rifiutato la richiesta."),
        ] {
            let err = status_error(CloudProvider::OpenAi, status, &body, key);
            assert_eq!(err.code(), "llm_unavailable");
            assert!(err.to_string().starts_with(needle), "{status}: {err}");
            let detail = err.detail().unwrap();
            assert!(!detail.contains(key), "{status}: {detail}");
            assert!(!err.to_string().contains(key));
        }
        assert!(is_rate_limited(&status_error(
            CloudProvider::Qwen,
            429,
            "",
            key
        )));
        assert!(!is_rate_limited(&status_error(
            CloudProvider::Qwen,
            500,
            "",
            key
        )));
    }
}
