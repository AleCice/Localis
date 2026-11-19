//! TEST FIXTURE ONLY: a fake OpenAI-compatible server standing in for LM Studio, on
//! 127.0.0.1 with a free port. It is not a model: answers are canned and embeddings are
//! deterministic token-hash vectors (same words → close vectors). Never used by the app.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

pub const CHAT_MODEL: &str = "fake-chat";
pub const EMBED_MODEL: &str = "fake-embed";
pub const EMBED_DIM: usize = 64;

/// Canned answer: cites [1] (valid), [99] (not a source), and has [2] only inside code and
/// math, so it must not count as a citation.
pub const ANSWER: &str = "La derivata di $x^2$ è $2x$ [1]. Vedi anche [99].\n\n\
```python\nprint(fonti[2])\n```\n\nIn sintesi: $$\\int_0^1 x\\,dx = \\tfrac12$$ e `[2]` resta codice; \
l'intervallo $[2, 3]$ non è una citazione.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatMode {
    /// Streams [`ANSWER`] in small pieces, with keep-alive comments and CRLF.
    Normal,
    /// HTTP 500.
    Error500,
    /// One piece every 50 ms for ~20 s (to test cancellation).
    Slow,
    /// Streams this text.
    Text(String),
}

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub body: String,
}

#[derive(Debug)]
pub struct FakeState {
    /// Serve LM Studio's `/api/v0/models` (otherwise 404, as plain OpenAI servers).
    pub models_v0: bool,
    pub chat: ChatMode,
    pub embeddings_fail: bool,
    pub requests: Vec<Recorded>,
}

pub struct FakeLm {
    pub url: String,
    pub state: Arc<Mutex<FakeState>>,
}

impl FakeLm {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(FakeState {
            models_v0: true,
            chat: ChatMode::Normal,
            embeddings_fail: false,
            requests: Vec::new(),
        }));
        let shared = Arc::clone(&state);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || {
                    let _ = handle(stream, &shared);
                });
            }
        });
        FakeLm { url, state }
    }

    pub fn set(&self, f: impl FnOnce(&mut FakeState)) {
        f(&mut self.state.lock().unwrap());
    }

    pub fn requests(&self, path: &str) -> Vec<Recorded> {
        self.state
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.path == path)
            .cloned()
            .collect()
    }
}

/// A loopback URL where nothing listens (connection refused).
pub fn closed_url() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    format!("http://127.0.0.1:{port}")
}

/// Deterministic embedding: each word (≥ 3 letters, normalized) adds 1 to a hashed slot.
pub fn token_vector(text: &str) -> Vec<f32> {
    let mut v = vec![0f32; EMBED_DIM];
    for word in localis_core::normalize_text(text).split_whitespace() {
        if word.chars().count() < 3 {
            continue;
        }
        let mut h: u64 = 0xcbf29ce484222325;
        for b in word.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x100000001b3);
        }
        v[(h % EMBED_DIM as u64) as usize] += 1.0;
    }
    if v.iter().all(|x| *x == 0.0) {
        v[0] = 1.0;
    }
    v
}

fn handle(stream: TcpStream, state: &Mutex<FakeState>) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_owned();
    let path = parts.next().unwrap_or_default().to_owned();
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body)?;
    let body = String::from_utf8_lossy(&body).into_owned();
    let (models_v0, chat, embeddings_fail) = {
        let mut s = state.lock().unwrap();
        s.requests.push(Recorded {
            method: method.clone(),
            path: path.clone(),
            body: body.clone(),
        });
        (s.models_v0, s.chat.clone(), s.embeddings_fail)
    };
    let mut out = stream;
    match (method.as_str(), path.as_str()) {
        ("GET", "/api/v0/models") if models_v0 => respond_json(
            &mut out,
            200,
            &json!({ "object": "list", "data": [
                { "id": CHAT_MODEL, "object": "model", "type": "llm", "state": "loaded" },
                { "id": "fake-vision", "object": "model", "type": "vlm", "state": "not-loaded" },
                { "id": EMBED_MODEL, "object": "model", "type": "embeddings", "state": "not-loaded" },
            ]}),
        ),
        ("GET", "/v1/models") => respond_json(
            &mut out,
            200,
            &json!({ "object": "list", "data": [
                { "id": CHAT_MODEL, "object": "model" },
                { "id": EMBED_MODEL, "object": "model" },
            ]}),
        ),
        ("POST", "/v1/embeddings") if embeddings_fail => respond_json(
            &mut out,
            500,
            &json!({ "error": "embedding model crashed" }),
        ),
        ("POST", "/v1/embeddings") => {
            let req: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            let inputs: Vec<String> = match &req["input"] {
                Value::String(s) => vec![s.clone()],
                Value::Array(a) => a
                    .iter()
                    .map(|x| x.as_str().unwrap_or_default().to_owned())
                    .collect(),
                _ => Vec::new(),
            };
            let data: Vec<Value> = inputs
                .iter()
                .enumerate()
                .map(|(i, t)| json!({ "object": "embedding", "index": i, "embedding": token_vector(t) }))
                .collect();
            respond_json(&mut out, 200, &json!({ "object": "list", "data": data }))
        }
        ("POST", "/v1/chat/completions") => match chat {
            ChatMode::Error500 => {
                respond_json(&mut out, 500, &json!({ "error": "model failed to load" }))
            }
            ChatMode::Normal => stream_text(&mut out, ANSWER, Duration::ZERO, 7),
            ChatMode::Text(text) => stream_text(&mut out, &text, Duration::ZERO, 7),
            ChatMode::Slow => {
                let text = "parola ".repeat(400);
                stream_text(&mut out, &text, Duration::from_millis(50), 7)
            }
        },
        _ => respond_json(&mut out, 404, &json!({ "error": "not found" })),
    }
}

fn respond_json(out: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let body = body.to_string();
    let reason = match status {
        200 => "OK",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    write!(
        out,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )?;
    out.flush()
}

fn write_chunk(out: &mut TcpStream, bytes: &[u8]) -> std::io::Result<()> {
    write!(out, "{:x}\r\n", bytes.len())?;
    out.write_all(bytes)?;
    out.write_all(b"\r\n")?;
    out.flush()
}

/// Streams `text` as SSE in pieces of `piece` characters, with chunk boundaries that split
/// lines (and UTF-8 sequences), CRLF endings and keep-alive comments.
fn stream_text(
    out: &mut TcpStream,
    text: &str,
    delay: Duration,
    piece: usize,
) -> std::io::Result<()> {
    write!(
        out,
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
    )?;
    let mut sse = String::from(": keep-alive\r\n\r\n");
    sse.push_str(&format!(
        "data: {}\r\n\r\n",
        json!({ "choices": [{ "index": 0, "delta": { "role": "assistant" } }] })
    ));
    let chars: Vec<char> = text.chars().collect();
    let mut events = vec![sse];
    for (i, part) in chars.chunks(piece).enumerate() {
        let s: String = part.iter().collect();
        let mut ev = format!(
            "data: {}\n\n",
            json!({ "choices": [{ "index": 0, "delta": { "content": s } }] })
        );
        if i % 5 == 4 {
            ev.push_str(": ping\n\n");
        }
        events.push(ev);
    }
    events.push("data: [DONE]\r\n\r\n".to_owned());
    if delay.is_zero() {
        // Arbitrary 13-byte chunks: lines and multibyte characters are split across reads.
        let all = events.concat().into_bytes();
        for c in all.chunks(13) {
            write_chunk(out, c)?;
        }
    } else {
        for ev in events {
            write_chunk(out, ev.as_bytes())?;
            std::thread::sleep(delay);
        }
    }
    out.write_all(b"0\r\n\r\n")?;
    out.flush()
}
