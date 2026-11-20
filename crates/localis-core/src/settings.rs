//! Model settings (LM Studio connection, chat and embedding models, PRISM routing),
//! stored in the `settings` table. Models are stored as JSON `{"provider", "model"}`.

use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

use crate::error::{CoreError, Result};
use crate::providers::{ModelRef, ProviderId};
use crate::store::Store;

pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:1234";
pub const MODEL_ID_MAX: usize = 300;
const URL_MAX: usize = 200;

const KEY_BASE_URL: &str = "llm.base_url";
const KEY_CHAT_MODEL: &str = "llm.chat_model";
const KEY_EMBEDDING_MODEL: &str = "llm.embedding_model";
const KEY_ROUTING: &str = "llm.routing";
const KEY_AUTO_MODELS: &str = "llm.auto_models";
/// Max candidates for automatic routing.
pub const AUTO_MODELS_MAX: usize = 20;

const URL_INVALID: &str =
    "Indirizzo non valido: usa http://127.0.0.1, http://localhost o http://[::1] con una porta (es. http://127.0.0.1:1234).";
const MODEL_INVALID: &str = "Il nome del modello non è valido.";
const EMBEDDING_PROVIDER_INVALID: &str =
    "Questo provider non offre modelli di embedding: scegli LM Studio, OpenAI, Google Gemini o Qwen.";
const AUTO_MODELS_TOO_MANY: &str = "Troppi modelli candidati (massimo 20).";
const AUTO_MODELS_EMPTY: &str =
    "Per l'instradamento automatico aggiungi almeno un modello candidato.";

/// PRISM routing mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Routing {
    /// Always `chat_model`.
    #[default]
    Manual,
    /// Picked per question from `auto_models` (see `prism`).
    Auto,
}

impl Routing {
    pub fn as_str(self) -> &'static str {
        match self {
            Routing::Manual => "manual",
            Routing::Auto => "auto",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "manual" => Some(Routing::Manual),
            "auto" => Some(Routing::Auto),
            _ => None,
        }
    }
}

/// Model settings (`LlmSettings` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmSettings {
    /// LM Studio: normalized loopback URL without trailing `/`.
    pub base_url: String,
    pub chat_model: Option<ModelRef>,
    /// `None` = lexical retrieval only.
    pub embedding_model: Option<ModelRef>,
    pub routing: Routing,
    /// Ordered candidates for automatic routing.
    pub auto_models: Vec<ModelRef>,
}

impl Default for LlmSettings {
    fn default() -> Self {
        LlmSettings {
            base_url: DEFAULT_BASE_URL.to_owned(),
            chat_model: None,
            embedding_model: None,
            routing: Routing::Manual,
            auto_models: Vec::new(),
        }
    }
}

/// Validates and normalizes an LM Studio base URL. Only plain `http` to a loopback host
/// (`127.0.0.1`, `localhost`, `[::1]`) is accepted, with an optional port; no user info,
/// query or fragment. A trailing `/` or `/v1` is removed. Returns e.g. `http://127.0.0.1:1234`.
pub fn validate_base_url(raw: &str) -> Result<String> {
    let invalid = || CoreError::validation("baseUrl", URL_INVALID);
    let url = raw.trim();
    if url.is_empty()
        || url.len() > URL_MAX
        || url.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid());
    }
    let (scheme, rest) = url.split_once("://").ok_or_else(invalid)?;
    if !scheme.eq_ignore_ascii_case("http") {
        return Err(invalid());
    }
    if rest.contains(['?', '#', '@', '\\', '%']) {
        return Err(invalid());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let path = path.trim_end_matches('/');
    if !(path.is_empty() || path.eq_ignore_ascii_case("/v1")) {
        return Err(invalid());
    }
    let (host, port) = if let Some(after) = authority.strip_prefix('[') {
        let (inside, tail) = after.split_once(']').ok_or_else(invalid)?;
        if inside != "::1" {
            return Err(invalid());
        }
        ("[::1]".to_owned(), tail)
    } else {
        let (host, tail) = match authority.find(':') {
            Some(i) => (&authority[..i], &authority[i..]),
            None => (authority, ""),
        };
        let host = host.to_ascii_lowercase();
        if host != "127.0.0.1" && host != "localhost" {
            return Err(invalid());
        }
        (host, tail)
    };
    let port = match port {
        "" => None,
        p => {
            let digits = p.strip_prefix(':').ok_or_else(invalid)?;
            if digits.is_empty() || digits.len() > 5 || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return Err(invalid());
            }
            let n: u32 = digits.parse().map_err(|_| invalid())?;
            if !(1..=65535).contains(&n) {
                return Err(invalid());
            }
            Some(n)
        }
    };
    Ok(match port {
        Some(p) => format!("http://{host}:{p}"),
        None => format!("http://{host}"),
    })
}

/// Validates a model id (trimmed, not empty, no control characters).
pub(crate) fn validate_model_id(raw: &str, field: &'static str) -> Result<String> {
    let model = raw.trim();
    if model.is_empty() || model.chars().count() > MODEL_ID_MAX || model.chars().any(char::is_control)
    {
        return Err(CoreError::validation(field, MODEL_INVALID));
    }
    Ok(model.to_owned())
}

fn validate_ref(model: &Option<ModelRef>, field: &'static str) -> Result<Option<ModelRef>> {
    match model {
        None => Ok(None),
        // An empty id means "none chosen".
        Some(m) if m.model.trim().is_empty() => Ok(None),
        Some(m) => Ok(Some(ModelRef {
            provider: m.provider,
            model: validate_model_id(&m.model, field)?,
        })),
    }
}

fn ref_to_json(m: &ModelRef) -> String {
    json!({ "provider": m.provider.as_str(), "model": m.model }).to_string()
}

fn ref_from_value(v: &Value) -> Option<ModelRef> {
    let provider = ProviderId::parse(v.get("provider")?.as_str()?)?;
    let model = v.get("model")?.as_str()?.trim();
    (!model.is_empty()).then(|| ModelRef::new(provider, model))
}

/// A stored model: JSON `{provider, model}`; anything else is ignored (treated as none).
fn ref_from_stored(raw: &str) -> Option<ModelRef> {
    serde_json::from_str::<Value>(raw)
        .ok()
        .as_ref()
        .and_then(ref_from_value)
}

/// Validates settings as saved by [`Store::set_llm_settings`].
pub fn validate_llm_settings(input: &LlmSettings) -> Result<LlmSettings> {
    let chat_model = validate_ref(&input.chat_model, "chatModel")?;
    let embedding_model = validate_ref(&input.embedding_model, "embeddingModel")?;
    if let Some(m) = &embedding_model {
        if !m.provider.supports_embeddings() {
            return Err(CoreError::validation(
                "embeddingModel",
                EMBEDDING_PROVIDER_INVALID,
            ));
        }
    }
    let mut auto_models: Vec<ModelRef> = Vec::new();
    for m in &input.auto_models {
        let Some(m) = validate_ref(&Some(m.clone()), "autoModels")? else {
            continue;
        };
        if !auto_models.contains(&m) {
            auto_models.push(m);
        }
    }
    if auto_models.len() > AUTO_MODELS_MAX {
        return Err(CoreError::validation("autoModels", AUTO_MODELS_TOO_MANY));
    }
    if input.routing == Routing::Auto && auto_models.is_empty() {
        return Err(CoreError::validation("autoModels", AUTO_MODELS_EMPTY));
    }
    Ok(LlmSettings {
        base_url: validate_base_url(&input.base_url)?,
        chat_model,
        embedding_model,
        routing: input.routing,
        auto_models,
    })
}

impl Store {
    pub(crate) fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Current model settings (defaults when never saved).
    pub fn llm_settings(&self) -> Result<LlmSettings> {
        let base_url = self
            .setting(KEY_BASE_URL)?
            .and_then(|u| validate_base_url(&u).ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let auto_models = self
            .setting(KEY_AUTO_MODELS)?
            .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
            .map(|items| items.iter().filter_map(ref_from_value).collect())
            .unwrap_or_default();
        Ok(LlmSettings {
            base_url,
            chat_model: self
                .setting(KEY_CHAT_MODEL)?
                .as_deref()
                .and_then(ref_from_stored),
            embedding_model: self
                .setting(KEY_EMBEDDING_MODEL)?
                .as_deref()
                .and_then(ref_from_stored)
                .filter(|m| m.provider.supports_embeddings()),
            routing: self
                .setting(KEY_ROUTING)?
                .as_deref()
                .and_then(Routing::parse)
                .unwrap_or_default(),
            auto_models,
        })
    }

    /// Validates (loopback http only for LM Studio) and saves the settings; returns them
    /// normalized.
    pub fn set_llm_settings(&mut self, input: &LlmSettings) -> Result<LlmSettings> {
        let settings = validate_llm_settings(input)?;
        let auto = Value::from(
            settings
                .auto_models
                .iter()
                .map(|m| json!({ "provider": m.provider.as_str(), "model": m.model }))
                .collect::<Vec<_>>(),
        )
        .to_string();
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (key, value) in [
            (KEY_BASE_URL, Some(settings.base_url.clone())),
            (KEY_CHAT_MODEL, settings.chat_model.as_ref().map(ref_to_json)),
            (
                KEY_EMBEDDING_MODEL,
                settings.embedding_model.as_ref().map(ref_to_json),
            ),
            (KEY_ROUTING, Some(settings.routing.as_str().to_owned())),
            (KEY_AUTO_MODELS, Some(auto)),
        ] {
            match value {
                Some(v) => tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, ?2)
                     ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                    params![key, v],
                )?,
                None => tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?,
            };
        }
        tx.commit()?;
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::CloudProvider;

    #[test]
    fn accepted_urls_are_normalized() {
        for (input, expected) in [
            ("http://127.0.0.1:1234", "http://127.0.0.1:1234"),
            ("  http://127.0.0.1:1234/  ", "http://127.0.0.1:1234"),
            ("HTTP://LOCALHOST:1234/v1/", "http://localhost:1234"),
            ("http://localhost:8080/v1", "http://localhost:8080"),
            ("http://[::1]:1234", "http://[::1]:1234"),
            ("http://[::1]", "http://[::1]"),
            ("http://localhost", "http://localhost"),
            ("http://127.0.0.1:65535//", "http://127.0.0.1:65535"),
        ] {
            assert_eq!(validate_base_url(input).unwrap(), expected, "{input}");
        }
    }

    #[test]
    fn non_loopback_and_tricky_urls_are_rejected() {
        for input in [
            "",
            "127.0.0.1:1234",
            "https://127.0.0.1:1234",
            "ftp://127.0.0.1",
            "http://127.0.0.1.evil.com:1234",
            "http://localhost.evil.com",
            "http://evil.com",
            "http://localhost@evil.com",
            "http://evil.com@localhost:1234",
            "http://user:pass@127.0.0.1:1234",
            "http://127.0.0.2:1234",
            "http://0.0.0.0:1234",
            "http://192.168.1.10:1234",
            "http://[::2]:1234",
            "http://[::ffff:127.0.0.1]:1234",
            "http://[::1",
            "http://[::1]x",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:",
            "http://127.0.0.1:12a4",
            "http://127.0.0.1:1234/api",
            "http://127.0.0.1:1234/v1/chat",
            "http://127.0.0.1:1234?x=1",
            "http://127.0.0.1:1234#frag",
            "http://127.0.0.1 :1234",
            "http://127.0.0.1\\@evil.com",
            "http://%31%32%37.0.0.1",
            "http://localhost\t:1234",
            "http://2130706433",
            "http://127.1",
        ] {
            let err = validate_base_url(input).unwrap_err();
            assert!(
                matches!(
                    err,
                    CoreError::Validation {
                        field: "baseUrl",
                        ..
                    }
                ),
                "{input:?}"
            );
        }
    }

    #[test]
    fn settings_round_trip_and_defaults() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(store.llm_settings().unwrap(), LlmSettings::default());
        let saved = store
            .set_llm_settings(&LlmSettings {
                base_url: "http://localhost:4321/".into(),
                chat_model: Some(ModelRef::lmstudio("  qwen  ")),
                embedding_model: Some(ModelRef::lmstudio("")),
                routing: Routing::Auto,
                auto_models: vec![
                    ModelRef::lmstudio("qwen"),
                    ModelRef::new(ProviderId::Cloud(CloudProvider::OpenAi), "gpt-x"),
                    ModelRef::lmstudio(" qwen "),
                ],
            })
            .unwrap();
        assert_eq!(
            saved,
            LlmSettings {
                base_url: "http://localhost:4321".into(),
                chat_model: Some(ModelRef::lmstudio("qwen")),
                embedding_model: None,
                routing: Routing::Auto,
                auto_models: vec![
                    ModelRef::lmstudio("qwen"),
                    ModelRef::new(ProviderId::Cloud(CloudProvider::OpenAi), "gpt-x"),
                ],
            }
        );
        assert_eq!(store.llm_settings().unwrap(), saved);
        let err = store
            .set_llm_settings(&LlmSettings {
                base_url: "http://example.com".into(),
                ..LlmSettings::default()
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Validation {
                field: "baseUrl",
                ..
            }
        ));
        assert_eq!(
            store.llm_settings().unwrap(),
            saved,
            "nothing saved on error"
        );
        let err = store
            .set_llm_settings(&LlmSettings {
                chat_model: Some(ModelRef::lmstudio("a\u{0}b")),
                ..LlmSettings::default()
            })
            .unwrap_err();
        assert!(matches!(
            err,
            CoreError::Validation {
                field: "chatModel",
                ..
            }
        ));
        for (input, field) in [
            (
                LlmSettings {
                    embedding_model: Some(ModelRef::new(
                        ProviderId::Cloud(CloudProvider::Anthropic),
                        "claude",
                    )),
                    ..LlmSettings::default()
                },
                "embeddingModel",
            ),
            (
                LlmSettings {
                    routing: Routing::Auto,
                    ..LlmSettings::default()
                },
                "autoModels",
            ),
            (
                LlmSettings {
                    auto_models: (0..=AUTO_MODELS_MAX)
                        .map(|i| ModelRef::lmstudio(&format!("m{i}")))
                        .collect(),
                    ..LlmSettings::default()
                },
                "autoModels",
            ),
        ] {
            let err = store.set_llm_settings(&input).unwrap_err();
            assert!(
                matches!(err, CoreError::Validation { field: f, .. } if f == field),
                "{err:?}"
            );
        }
        assert_eq!(store.llm_settings().unwrap(), saved);
    }

    #[test]
    fn unreadable_stored_models_are_ignored() {
        let store = Store::open_in_memory().unwrap();
        store
            .conn
            .execute_batch(
                "INSERT INTO settings VALUES ('llm.chat_model', 'not json');
                 INSERT INTO settings VALUES ('llm.embedding_model',
                     '{\"provider\":\"deepseek\",\"model\":\"x\"}');
                 INSERT INTO settings VALUES ('llm.routing', 'weird');
                 INSERT INTO settings VALUES ('llm.auto_models',
                     '[{\"provider\":\"nope\",\"model\":\"a\"},{\"provider\":\"gemini\",\"model\":\"g\"}]');",
            )
            .unwrap();
        let s = store.llm_settings().unwrap();
        assert_eq!(s.chat_model, None);
        assert_eq!(s.embedding_model, None, "DeepSeek has no embeddings");
        assert_eq!(s.routing, Routing::Manual);
        assert_eq!(
            s.auto_models,
            [ModelRef::new(ProviderId::Cloud(CloudProvider::Gemini), "g")]
        );
    }
}
