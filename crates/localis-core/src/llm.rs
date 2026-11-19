//! Minimal client for LM Studio's OpenAI-compatible HTTP API, on loopback only.
//!
//! Every request goes to a URL that passed [`validate_base_url`]; proxies from the
//! environment are ignored and redirects are never followed, so no request can leave the
//! machine.

use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::error::{CoreError, Result};
use crate::settings::validate_base_url;

/// Connection timeout for every request.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Total timeout of short calls (model list, query embedding).
pub const SHORT_TIMEOUT: Duration = Duration::from_secs(30);
/// Total timeout of one background embedding batch (up to [`EMBED_BATCH_MAX`] passages).
pub const EMBED_BATCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Chat streaming has no total timeout; a single read waiting longer than this fails
/// (a server that stopped responding). Cancellation does not wait for it.
pub const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(300);
/// Max texts per `/v1/embeddings` request.
pub const EMBED_BATCH_MAX: usize = 32;
const RESPONSE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CANCEL_POLL: Duration = Duration::from_millis(50);

const BAD_RESPONSE: &str = "LM Studio ha restituito una risposta non valida.";
const MODEL_FAILED: &str = "Il modello non ha risposto correttamente.";
const EMBEDDING_FAILED: &str = "Il modello di embedding non ha risposto correttamente.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    Llm,
    Embedding,
    Unknown,
}

impl ModelKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ModelKind::Llm => "llm",
            ModelKind::Embedding => "embedding",
            ModelKind::Unknown => "unknown",
        }
    }
}

/// A model reported by LM Studio (`ModelInfo` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelInfo {
    pub id: String,
    pub kind: ModelKind,
    /// `loaded` / `not-loaded` when reported (LM Studio's `/api/v0/models`).
    pub state: Option<String>,
}

/// Result of [`LlmClient::status`] (`LlmStatus` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmStatus {
    pub reachable: bool,
    pub message: Option<String>,
    pub detail: Option<String>,
    pub models: Vec<ModelInfo>,
}

/// One chat message for `/v1/chat/completions`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptMessage {
    pub role: &'static str,
    pub content: String,
}

/// How a streamed generation ended.
#[derive(Debug)]
pub enum StreamEnd {
    /// The server sent `[DONE]` or closed the stream normally.
    Finished,
    /// The cancel flag was set.
    Cancelled,
    /// Network/HTTP/protocol failure (`llm_unavailable`); text received so far was delivered.
    Failed(CoreError),
}

/// HTTP client bound to one validated loopback base URL.
#[derive(Debug, Clone)]
pub struct LlmClient {
    base_url: String,
}

fn agent(total: Option<Duration>, per_read: Option<Duration>) -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_global(total)
        .timeout_per_read(per_read)
        .user_agent("Localis")
        .build()
        .new_agent()
}

fn http_detail(status: u16, body: &str) -> String {
    let snippet: String = body.chars().take(300).collect();
    format!("HTTP {status}: {snippet}")
}

impl LlmClient {
    /// Fails with `validation` unless `base_url` is a loopback http URL.
    pub fn new(base_url: &str) -> Result<Self> {
        Ok(LlmClient {
            base_url: validate_base_url(base_url)?,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn unreachable(&self, detail: impl ToString) -> CoreError {
        CoreError::llm(unreachable_message(&self.base_url), detail)
    }

    /// GET returning (status, body).
    fn get(&self, path: &str) -> Result<(u16, String)> {
        let url = format!("{}{path}", self.base_url);
        let mut resp = agent(Some(SHORT_TIMEOUT), None)
            .get(&url)
            .call()
            .map_err(|e| self.unreachable(format!("GET {url}: {e}")))?;
        let status = resp.status().as_u16();
        let body = resp
            .body_mut()
            .with_config()
            .limit(RESPONSE_MAX_BYTES)
            .read_to_string()
            .map_err(|e| self.unreachable(format!("GET {url}: {e}")))?;
        Ok((status, body))
    }

    fn post_json(&self, path: &str, body: &Value, total: Duration) -> Result<(u16, String)> {
        let url = format!("{}{path}", self.base_url);
        let bytes = serde_json::to_vec(body).map_err(|e| CoreError::Internal(e.to_string()))?;
        let mut resp = agent(Some(total), None)
            .post(&url)
            .header("Content-Type", "application/json")
            .send(&bytes[..])
            .map_err(|e| self.unreachable(format!("POST {url}: {e}")))?;
        let status = resp.status().as_u16();
        let text = resp
            .body_mut()
            .with_config()
            .limit(RESPONSE_MAX_BYTES)
            .read_to_string()
            .map_err(|e| self.unreachable(format!("POST {url}: {e}")))?;
        Ok((status, text))
    }

    /// Lists models: LM Studio's `/api/v0/models` (with kind and load state), or the
    /// OpenAI-compatible `/v1/models` when the former is missing (404).
    pub fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let (status, body) = self.get("/api/v0/models")?;
        if status == 200 {
            return parse_models(&body, true)
                .ok_or_else(|| CoreError::llm(BAD_RESPONSE, http_detail(status, &body)));
        }
        if status != 404 {
            return Err(CoreError::llm(BAD_RESPONSE, http_detail(status, &body)));
        }
        let (status, body) = self.get("/v1/models")?;
        if status != 200 {
            return Err(CoreError::llm(BAD_RESPONSE, http_detail(status, &body)));
        }
        parse_models(&body, false)
            .ok_or_else(|| CoreError::llm(BAD_RESPONSE, http_detail(status, &body)))
    }

    /// Contacts LM Studio and lists its models. Never fails: an unreachable server is
    /// reported in the result.
    pub fn status(&self) -> LlmStatus {
        match self.list_models() {
            Ok(models) => LlmStatus {
                reachable: true,
                message: None,
                detail: None,
                models,
            },
            Err(err) => LlmStatus {
                reachable: false,
                message: Some(err.to_string()),
                detail: err.detail().map(str::to_owned),
                models: Vec::new(),
            },
        }
    }

    /// Embeds `texts` (at most [`EMBED_BATCH_MAX`]) with `model`; vectors are L2-normalized.
    pub fn embed(&self, model: &str, texts: &[String], total: Duration) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        if texts.len() > EMBED_BATCH_MAX {
            return Err(CoreError::Internal(format!(
                "embedding batch of {} texts exceeds {EMBED_BATCH_MAX}",
                texts.len()
            )));
        }
        let (status, body) = self.post_json(
            "/v1/embeddings",
            &json!({ "model": model, "input": texts }),
            total,
        )?;
        if status != 200 {
            return Err(CoreError::llm(EMBEDDING_FAILED, http_detail(status, &body)));
        }
        parse_embeddings(&body, texts.len())
            .ok_or_else(|| CoreError::llm(EMBEDDING_FAILED, http_detail(status, &body)))
    }

    /// Streams a chat completion. `on_delta` receives each piece of text as it arrives.
    /// `cancel` is checked between reads (at least every 50 ms, also while waiting for the
    /// server), so cancelling never waits on the network.
    pub fn chat_stream(
        &self,
        model: &str,
        messages: &[PromptMessage],
        cancel: &AtomicBool,
        on_delta: &mut dyn FnMut(&str),
    ) -> StreamEnd {
        let url = format!("{}/v1/chat/completions", self.base_url);
        let body = json!({
            "model": model,
            "messages": messages
                .iter()
                .map(|m| json!({ "role": m.role, "content": m.content }))
                .collect::<Vec<_>>(),
            "stream": true,
            "temperature": 0.2,
        });
        let bytes = match serde_json::to_vec(&body) {
            Ok(b) => b,
            Err(e) => return StreamEnd::Failed(CoreError::Internal(e.to_string())),
        };
        // The blocking HTTP read runs on its own thread; this thread polls the cancel flag.
        let (tx, rx) = mpsc::channel::<StreamMsg>();
        let stop = Arc::new(AtomicBool::new(false));
        let reader_stop = Arc::clone(&stop);
        let base = self.base_url.clone();
        let spawned = std::thread::Builder::new()
            .name("localis-chat-stream".into())
            .spawn(move || stream_worker(&base, &url, bytes, &reader_stop, &tx));
        if let Err(e) = spawned {
            return StreamEnd::Failed(CoreError::Internal(format!("cannot spawn reader: {e}")));
        }
        loop {
            if cancel.load(Ordering::SeqCst) {
                stop.store(true, Ordering::SeqCst);
                return StreamEnd::Cancelled;
            }
            match rx.recv_timeout(CANCEL_POLL) {
                Ok(StreamMsg::Delta(text)) => {
                    // Check the flag again: text arriving after a cancel is not delivered.
                    if cancel.load(Ordering::SeqCst) {
                        stop.store(true, Ordering::SeqCst);
                        return StreamEnd::Cancelled;
                    }
                    on_delta(&text);
                }
                Ok(StreamMsg::Done) => return StreamEnd::Finished,
                Ok(StreamMsg::Failed(err)) => return StreamEnd::Failed(err),
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return StreamEnd::Failed(CoreError::llm(MODEL_FAILED, "stream reader stopped"))
                }
            }
        }
    }
}

enum StreamMsg {
    Delta(String),
    Done,
    Failed(CoreError),
}

fn stream_worker(
    base: &str,
    url: &str,
    body: Vec<u8>,
    stop: &AtomicBool,
    tx: &mpsc::Sender<StreamMsg>,
) {
    let unreachable = |detail: String| CoreError::llm(unreachable_message(base), detail);
    let resp = agent(None, Some(STREAM_READ_TIMEOUT))
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .send(&body[..]);
    let mut resp = match resp {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(StreamMsg::Failed(unreachable(format!("POST {url}: {e}"))));
            return;
        }
    };
    let status = resp.status().as_u16();
    if status != 200 {
        let text = resp
            .body_mut()
            .with_config()
            .limit(1024 * 1024)
            .read_to_string()
            .unwrap_or_default();
        let _ = tx.send(StreamMsg::Failed(CoreError::llm(
            MODEL_FAILED,
            http_detail(status, &text),
        )));
        return;
    }
    let mut reader = resp.into_body().into_reader();
    let mut parser = SseParser::default();
    let mut buf = [0u8; 8192];
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                let _ = tx.send(StreamMsg::Failed(unreachable(format!("stream read: {e}"))));
                return;
            }
        };
        let events = if n == 0 {
            parser.finish()
        } else {
            parser.push(&buf[..n])
        };
        for event in events {
            let msg = match parse_chat_event(&event) {
                ChatChunk::Text(t) if t.is_empty() => continue,
                ChatChunk::Text(t) => StreamMsg::Delta(t),
                ChatChunk::Skip => continue,
                ChatChunk::Done => StreamMsg::Done,
                ChatChunk::Error(detail) => StreamMsg::Failed(CoreError::llm(MODEL_FAILED, detail)),
            };
            let terminal = !matches!(msg, StreamMsg::Delta(_));
            if tx.send(msg).is_err() || terminal {
                return;
            }
        }
        if n == 0 {
            let _ = tx.send(StreamMsg::Done);
            return;
        }
    }
}

/// Incremental parser of a `text/event-stream` body. Robust to events split across reads,
/// CRLF or CR line endings, comment lines (`: keep-alive`) and a missing final blank line.
/// Yields the `data` payload of each event (multiple `data:` lines joined with `\n`).
#[derive(Debug, Default)]
pub struct SseParser {
    pending: Vec<u8>,
    data: Vec<String>,
    has_data: bool,
}

impl SseParser {
    /// Feeds bytes; returns the events completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut events = Vec::new();
        while let Some(pos) = self.pending.iter().position(|&b| b == b'\n' || b == b'\r') {
            // A lone CR at the end of the buffer may be the first half of CRLF: wait.
            if self.pending[pos] == b'\r' && pos + 1 == self.pending.len() {
                break;
            }
            let mut line: Vec<u8> = self.pending.drain(..=pos).collect();
            let ending = line.pop();
            if ending == Some(b'\r') && self.pending.first() == Some(&b'\n') {
                self.pending.remove(0);
            }
            self.line(&String::from_utf8_lossy(&line), &mut events);
        }
        events
    }

    /// End of stream: completes a last event without its terminating blank line.
    pub fn finish(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        if !self.pending.is_empty() {
            let rest = std::mem::take(&mut self.pending);
            let text = String::from_utf8_lossy(&rest);
            self.line(text.trim_end_matches('\r'), &mut events);
        }
        self.line("", &mut events);
        events
    }

    fn line(&mut self, line: &str, events: &mut Vec<String>) {
        if line.is_empty() {
            if self.has_data {
                events.push(self.data.join("\n"));
            }
            self.data.clear();
            self.has_data = false;
            return;
        }
        if line.starts_with(':') {
            return; // comment / keep-alive
        }
        let (field, value) = match line.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        if field == "data" {
            self.data.push(value.to_owned());
            self.has_data = true;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ChatChunk {
    Text(String),
    Skip,
    Done,
    Error(String),
}

fn parse_chat_event(data: &str) -> ChatChunk {
    let data = data.trim();
    if data == "[DONE]" {
        return ChatChunk::Done;
    }
    let Ok(value) = serde_json::from_str::<Value>(data) else {
        return ChatChunk::Error(format!("invalid stream event: {}", truncate(data, 200)));
    };
    if let Some(err) = value.get("error") {
        return ChatChunk::Error(format!("model error: {}", truncate(&err.to_string(), 300)));
    }
    match value
        .pointer("/choices/0/delta/content")
        .and_then(Value::as_str)
    {
        Some(text) => ChatChunk::Text(text.to_owned()),
        None => ChatChunk::Skip,
    }
}

fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn parse_models(body: &str, lmstudio: bool) -> Option<Vec<ModelInfo>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let data = value.get("data")?.as_array()?;
    let mut models = Vec::new();
    for item in data {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        let (kind, state) = if lmstudio {
            let kind = match item.get("type").and_then(Value::as_str) {
                Some("llm" | "vlm") => ModelKind::Llm,
                Some("embeddings" | "embedding") => ModelKind::Embedding,
                _ => ModelKind::Unknown,
            };
            let state = item.get("state").and_then(Value::as_str).map(str::to_owned);
            (kind, state)
        } else {
            (ModelKind::Unknown, None)
        };
        models.push(ModelInfo {
            id: id.to_owned(),
            kind,
            state,
        });
    }
    Some(models)
}

fn parse_embeddings(body: &str, expected: usize) -> Option<Vec<Vec<f32>>> {
    let value: Value = serde_json::from_str(body).ok()?;
    let data = value.get("data")?.as_array()?;
    if data.len() != expected {
        return None;
    }
    let mut out: Vec<Option<Vec<f32>>> = vec![None; expected];
    for (pos, item) in data.iter().enumerate() {
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .map_or(pos, |i| i as usize);
        let raw = item.get("embedding")?.as_array()?;
        let mut vector = Vec::with_capacity(raw.len());
        for x in raw {
            vector.push(x.as_f64()? as f32);
        }
        let vector = normalize(vector)?;
        *out.get_mut(index)? = Some(vector);
    }
    let vectors: Vec<Vec<f32>> = out.into_iter().collect::<Option<_>>()?;
    let dim = vectors.first()?.len();
    vectors.iter().all(|v| v.len() == dim).then_some(vectors)
}

/// L2-normalizes; `None` for empty, zero or non-finite vectors.
pub(crate) fn normalize(mut v: Vec<f32>) -> Option<Vec<f32>> {
    if v.is_empty() || v.iter().any(|x| !x.is_finite()) {
        return None;
    }
    let norm = v
        .iter()
        .map(|x| f64::from(*x) * f64::from(*x))
        .sum::<f64>()
        .sqrt();
    if norm == 0.0 || !norm.is_finite() {
        return None;
    }
    for x in &mut v {
        *x = (f64::from(*x) / norm) as f32;
    }
    Some(v)
}

fn unreachable_message(base_url: &str) -> String {
    format!("LM Studio non risponde su {base_url}. Avvia LM Studio e il suo server locale.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(chunks: &[&[u8]]) -> Vec<String> {
        let mut p = SseParser::default();
        let mut events = Vec::new();
        for c in chunks {
            events.extend(p.push(c));
        }
        events.extend(p.finish());
        events
    }

    #[test]
    fn sse_basic_and_multiline() {
        let events = feed_all(&[b"data: a\n\ndata: b\ndata: c\n\n"]);
        assert_eq!(events, ["a", "b\nc"]);
    }

    #[test]
    fn sse_split_lines_crlf_comments_and_eof() {
        let events = feed_all(&[
            b": keep-alive\r\n\r\nda",
            b"ta: {\"x\":1}\r",
            b"\n\r\nevent: message\ndata:no-space\r\rdata: last",
        ]);
        assert_eq!(events, ["{\"x\":1}", "no-space", "last"]);
    }

    #[test]
    fn sse_byte_by_byte_with_utf8() {
        let input = "data: città è [1]\r\n\r\ndata: [DONE]\r\n\r\n".as_bytes();
        let chunks: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(feed_all(&chunks), ["città è [1]", "[DONE]"]);
    }

    #[test]
    fn chat_events_are_parsed() {
        assert_eq!(parse_chat_event("[DONE]"), ChatChunk::Done);
        assert_eq!(
            parse_chat_event(r#"{"choices":[{"delta":{"content":"ciao"}}]}"#),
            ChatChunk::Text("ciao".into())
        );
        assert_eq!(
            parse_chat_event(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#),
            ChatChunk::Skip
        );
        assert!(matches!(
            parse_chat_event(r#"{"error":{"message":"boom"}}"#),
            ChatChunk::Error(_)
        ));
        assert!(matches!(parse_chat_event("not json"), ChatChunk::Error(_)));
    }

    #[test]
    fn models_are_parsed() {
        let v0 = r#"{"data":[{"id":"qwen","type":"llm","state":"loaded"},
            {"id":"llava","type":"vlm","state":"not-loaded"},
            {"id":"nomic","type":"embeddings","state":"not-loaded"},
            {"id":"other","type":"tts"},{"noid":1}]}"#;
        let models = parse_models(v0, true).unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].kind, ModelKind::Llm);
        assert_eq!(models[0].state.as_deref(), Some("loaded"));
        assert_eq!(models[1].kind, ModelKind::Llm);
        assert_eq!(models[2].kind, ModelKind::Embedding);
        assert_eq!(models[3].kind, ModelKind::Unknown);
        let v1 = r#"{"object":"list","data":[{"id":"m1","object":"model"}]}"#;
        assert_eq!(
            parse_models(v1, false).unwrap(),
            [ModelInfo {
                id: "m1".into(),
                kind: ModelKind::Unknown,
                state: None
            }]
        );
        assert!(parse_models("[]", false).is_none());
    }

    #[test]
    fn embeddings_are_parsed_reordered_and_normalized() {
        let body = r#"{"data":[{"index":1,"embedding":[0,2]},{"index":0,"embedding":[3,4]}]}"#;
        let v = parse_embeddings(body, 2).unwrap();
        assert_eq!(v[0], [0.6, 0.8]);
        assert_eq!(v[1], [0.0, 1.0]);
        assert!(parse_embeddings(body, 3).is_none());
        assert!(parse_embeddings(r#"{"data":[{"embedding":[0,0]}]}"#, 1).is_none());
        assert!(
            parse_embeddings(r#"{"data":[{"embedding":[1]},{"embedding":[1,2]}]}"#, 2).is_none()
        );
    }

    #[test]
    fn client_requires_loopback() {
        assert!(LlmClient::new("http://example.com").is_err());
        assert_eq!(
            LlmClient::new("http://localhost:1234/v1")
                .unwrap()
                .base_url(),
            "http://localhost:1234"
        );
    }
}
