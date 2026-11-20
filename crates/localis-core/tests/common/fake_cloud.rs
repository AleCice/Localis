//! TEST FIXTURE ONLY: fake cloud provider APIs on 127.0.0.1 (one server per provider),
//! reached through the debug-only `Endpoints::with_test_override`. Canned answers, fixed
//! usage numbers and deterministic embeddings; modes for HTTP errors and slow streams.
//! It checks the provider's auth header against the expected key, like the real APIs.
//! Never used by the app.
#![allow(dead_code)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use localis_core::CloudProvider;
use serde_json::{json, Value};

use super::fake_lm::token_vector;

pub const CLOUD_ANSWER: &str = "Risposta dal cloud: la derivata misura la variazione [1].";
/// Usage reported by the fakes (input, output).
pub const OPENAI_USAGE: (u64, u64) = (120, 30);
pub const ANTHROPIC_USAGE: (u64, u64) = (25, 15);
pub const GEMINI_USAGE: (u64, u64) = (9, 2);
pub const EMBED_USAGE: u64 = 7;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    Normal,
    /// Answer every request with this HTTP status.
    Status(u16),
    /// Stream slowly (one piece every 50 ms for ~20 s).
    Slow,
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    /// Path with query.
    pub path: String,
    /// Lowercased header names.
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl Recorded {
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

#[derive(Debug)]
pub struct CloudState {
    pub mode: Mode,
    pub embed_mode: Mode,
    pub key: String,
    pub requests: Vec<Recorded>,
}

pub struct FakeCloud {
    pub provider: CloudProvider,
    pub url: String,
    pub state: Arc<Mutex<CloudState>>,
}

impl FakeCloud {
    pub fn start(provider: CloudProvider, key: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(CloudState {
            mode: Mode::Normal,
            embed_mode: Mode::Normal,
            key: key.to_owned(),
            requests: Vec::new(),
        }));
        let shared = Arc::clone(&state);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    let _ = handle(provider, stream, &shared);
                });
            }
        });
        FakeCloud {
            provider,
            url,
            state,
        }
    }

    pub fn set(&self, f: impl FnOnce(&mut CloudState)) {
        f(&mut self.state.lock().unwrap());
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn count(&self) -> usize {
        self.state.lock().unwrap().requests.len()
    }

    /// Requests whose path contains `needle`.
    pub fn matching(&self, needle: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|r| r.path.contains(needle))
            .collect()
    }
}

fn prefix(provider: CloudProvider) -> &'static str {
    match provider {
        CloudProvider::OpenAi | CloudProvider::Anthropic => "/v1",
        CloudProvider::Gemini => "/v1beta",
        CloudProvider::DeepSeek => "",
        CloudProvider::Qwen => "/compatible-mode/v1",
    }
}

fn authorized(provider: CloudProvider, headers: &HashMap<String, String>, key: &str) -> bool {
    match provider {
        CloudProvider::Anthropic => {
            headers.get("x-api-key").map(String::as_str) == Some(key)
                && headers.get("anthropic-version").map(String::as_str) == Some("2023-06-01")
        }
        CloudProvider::Gemini => headers.get("x-goog-api-key").map(String::as_str) == Some(key),
        _ => headers.get("authorization") == Some(&format!("Bearer {key}")),
    }
}

fn handle(
    provider: CloudProvider,
    stream: TcpStream,
    state: &Mutex<CloudState>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut headers = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let len: usize = headers
        .get("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    let body = String::from_utf8_lossy(&body).into_owned();
    let (mode, embed_mode, key) = {
        let mut s = state.lock().unwrap();
        s.requests.push(Recorded {
            method: method.clone(),
            path: path.clone(),
            headers: headers.clone(),
            body: body.clone(),
        });
        (s.mode.clone(), s.embed_mode.clone(), s.key.clone())
    };
    let mut out = stream;
    let rest = path.strip_prefix(prefix(provider)).unwrap_or("");
    let is_embed = rest.starts_with("/embeddings") || rest.contains(":batchEmbedContents");
    let mode = if is_embed { embed_mode } else { mode };
    if !authorized(provider, &headers, &key) {
        // Like some real APIs, echo part of what was sent (must never reach Localis' logs).
        let sent = headers
            .get("authorization")
            .or(headers.get("x-api-key"))
            .or(headers.get("x-goog-api-key"))
            .cloned()
            .unwrap_or_default();
        return respond(
            &mut out,
            401,
            &json!({ "error": format!("Incorrect API key provided: {sent}") }),
        );
    }
    if let Mode::Status(status) = mode {
        return respond(
            &mut out,
            status,
            &json!({ "error": { "message": format!("synthetic {status}"), "echo": key } }),
        );
    }
    let slow = mode == Mode::Slow;
    let route = rest.split('?').next().unwrap_or("");
    match (provider, method.as_str(), route) {
        (CloudProvider::Gemini, "GET", "/models") => {
            let page2 = path.contains("pageToken=p2");
            let body = if page2 {
                json!({ "models": [
                    { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] },
                ]})
            } else {
                json!({ "models": [
                    { "name": "models/gemini-fake", "supportedGenerationMethods": ["generateContent", "countTokens"] },
                    { "name": "models/aqa", "supportedGenerationMethods": ["generateAnswer"] },
                ], "nextPageToken": "p2" })
            };
            respond(&mut out, 200, &body)
        }
        (CloudProvider::Anthropic, "GET", "/models") => {
            let page2 = path.contains("after_id=claude-b");
            let body = if page2 {
                json!({ "data": [{ "id": "claude-c", "type": "model" }], "has_more": false, "last_id": "claude-c" })
            } else {
                json!({ "data": [{ "id": "claude-a", "type": "model" }, { "id": "claude-b", "type": "model" }],
                        "has_more": true, "last_id": "claude-b" })
            };
            respond(&mut out, 200, &body)
        }
        (_, "GET", "/models") => respond(
            &mut out,
            200,
            &json!({ "object": "list", "data": [
                { "id": "chat-fake", "object": "model" },
                { "id": "text-embedding-fake", "object": "model" },
            ]}),
        ),
        (CloudProvider::Anthropic, "POST", "/messages") => stream_anthropic(&mut out, slow),
        (CloudProvider::Gemini, "POST", r) if r.ends_with(":streamGenerateContent") => {
            stream_gemini(&mut out, slow)
        }
        (CloudProvider::Gemini, "POST", r) if r.ends_with(":batchEmbedContents") => {
            let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let embeddings: Vec<Value> = req["requests"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|r| {
                    let text = r["content"]["parts"][0]["text"]
                        .as_str()
                        .unwrap_or_default();
                    json!({ "values": token_vector(text) })
                })
                .collect();
            respond(&mut out, 200, &json!({ "embeddings": embeddings }))
        }
        (_, "POST", "/chat/completions") => stream_openai(&mut out, slow),
        (_, "POST", "/embeddings") => {
            let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let data: Vec<Value> = req["input"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .enumerate()
                .map(|(i, t)| json!({ "index": i, "embedding": token_vector(t.as_str().unwrap_or_default()) }))
                .collect();
            respond(
                &mut out,
                200,
                &json!({ "data": data, "usage": { "prompt_tokens": EMBED_USAGE, "total_tokens": EMBED_USAGE } }),
            )
        }
        _ => respond(&mut out, 404, &json!({ "error": "not found" })),
    }
}

fn respond(out: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let body = body.to_string();
    write!(
        out,
        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

fn start_stream(out: &mut TcpStream) -> std::io::Result<()> {
    write!(
        out,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )
}

fn chunk(out: &mut TcpStream, s: &str) -> std::io::Result<()> {
    write!(out, "{:x}\r\n", s.len())?;
    out.write_all(s.as_bytes())?;
    out.write_all(b"\r\n")?;
    out.flush()
}

fn end_stream(out: &mut TcpStream) -> std::io::Result<()> {
    out.write_all(b"0\r\n\r\n")?;
    out.flush()
}

fn pieces(slow: bool) -> (Vec<String>, Duration) {
    if slow {
        (vec!["parola ".to_owned(); 400], Duration::from_millis(50))
    } else {
        let chars: Vec<char> = CLOUD_ANSWER.chars().collect();
        (
            chars.chunks(9).map(|c| c.iter().collect()).collect(),
            Duration::ZERO,
        )
    }
}

fn stream_openai(out: &mut TcpStream, slow: bool) -> std::io::Result<()> {
    start_stream(out)?;
    let (parts, delay) = pieces(slow);
    for p in parts {
        chunk(
            out,
            &format!(
                "data: {}\n\n",
                json!({ "choices": [{ "index": 0, "delta": { "content": p } }] })
            ),
        )?;
        std::thread::sleep(delay);
    }
    chunk(
        out,
        &format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({ "choices": [], "usage": { "prompt_tokens": OPENAI_USAGE.0, "completion_tokens": OPENAI_USAGE.1 } })
        ),
    )?;
    end_stream(out)
}

fn stream_anthropic(out: &mut TcpStream, slow: bool) -> std::io::Result<()> {
    start_stream(out)?;
    chunk(
        out,
        &format!(
            "event: message_start\ndata: {}\n\nevent: ping\ndata: {{\"type\":\"ping\"}}\n\n",
            json!({ "type": "message_start", "message": { "usage": { "input_tokens": ANTHROPIC_USAGE.0, "output_tokens": 1 } } })
        ),
    )?;
    let (parts, delay) = pieces(slow);
    for p in parts {
        chunk(
            out,
            &format!(
                "event: content_block_delta\ndata: {}\n\n",
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": p } })
            ),
        )?;
        std::thread::sleep(delay);
    }
    chunk(
        out,
        &format!(
            "event: message_delta\ndata: {}\n\nevent: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n",
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" }, "usage": { "output_tokens": ANTHROPIC_USAGE.1 } })
        ),
    )?;
    end_stream(out)
}

fn stream_gemini(out: &mut TcpStream, slow: bool) -> std::io::Result<()> {
    start_stream(out)?;
    let (parts, delay) = pieces(slow);
    let n = parts.len();
    for (i, p) in parts.into_iter().enumerate() {
        let mut ev =
            json!({ "candidates": [{ "content": { "role": "model", "parts": [{ "text": p }] } }] });
        if i + 1 == n {
            ev["usageMetadata"] = json!({ "promptTokenCount": GEMINI_USAGE.0, "candidatesTokenCount": GEMINI_USAGE.1 });
        }
        chunk(out, &format!("data: {ev}\r\n\r\n"))?;
        std::thread::sleep(delay);
    }
    end_stream(out)
}
