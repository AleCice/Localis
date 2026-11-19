//! LM Studio connection settings, stored in the `settings` table.

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::error::{CoreError, Result};
use crate::store::Store;

pub const DEFAULT_BASE_URL: &str = "http://127.0.0.1:1234";
pub const MODEL_ID_MAX: usize = 300;
const URL_MAX: usize = 200;

const KEY_BASE_URL: &str = "llm.base_url";
const KEY_CHAT_MODEL: &str = "llm.chat_model";
const KEY_EMBEDDING_MODEL: &str = "llm.embedding_model";

const URL_INVALID: &str =
    "Indirizzo non valido: usa http://127.0.0.1, http://localhost o http://[::1] con una porta (es. http://127.0.0.1:1234).";
const MODEL_INVALID: &str = "Il nome del modello non è valido.";

/// Connection to LM Studio (`LlmSettings` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LlmSettings {
    /// Normalized loopback URL without trailing `/`.
    pub base_url: String,
    pub chat_model: Option<String>,
    /// `None` = lexical retrieval only.
    pub embedding_model: Option<String>,
}

impl Default for LlmSettings {
    fn default() -> Self {
        LlmSettings {
            base_url: DEFAULT_BASE_URL.to_owned(),
            chat_model: None,
            embedding_model: None,
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

fn validate_model(raw: Option<&str>) -> Result<Option<String>> {
    let Some(model) = raw.map(str::trim).filter(|m| !m.is_empty()) else {
        return Ok(None);
    };
    if model.chars().count() > MODEL_ID_MAX || model.chars().any(char::is_control) {
        return Err(CoreError::validation("model", MODEL_INVALID));
    }
    Ok(Some(model.to_owned()))
}

impl Store {
    fn setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Current LM Studio settings (defaults when never saved).
    pub fn llm_settings(&self) -> Result<LlmSettings> {
        let base_url = self
            .setting(KEY_BASE_URL)?
            .and_then(|u| validate_base_url(&u).ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        Ok(LlmSettings {
            base_url,
            chat_model: self.setting(KEY_CHAT_MODEL)?.filter(|m| !m.is_empty()),
            embedding_model: self.setting(KEY_EMBEDDING_MODEL)?.filter(|m| !m.is_empty()),
        })
    }

    /// Validates (loopback http only) and saves the settings; returns them normalized.
    pub fn set_llm_settings(&mut self, input: &LlmSettings) -> Result<LlmSettings> {
        let settings = LlmSettings {
            base_url: validate_base_url(&input.base_url)?,
            chat_model: validate_model(input.chat_model.as_deref())
                .map_err(|_| CoreError::validation("chatModel", MODEL_INVALID))?,
            embedding_model: validate_model(input.embedding_model.as_deref())
                .map_err(|_| CoreError::validation("embeddingModel", MODEL_INVALID))?,
        };
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (key, value) in [
            (KEY_BASE_URL, Some(settings.base_url.as_str())),
            (KEY_CHAT_MODEL, settings.chat_model.as_deref()),
            (KEY_EMBEDDING_MODEL, settings.embedding_model.as_deref()),
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
                chat_model: Some("  qwen  ".into()),
                embedding_model: Some("".into()),
            })
            .unwrap();
        assert_eq!(
            saved,
            LlmSettings {
                base_url: "http://localhost:4321".into(),
                chat_model: Some("qwen".into()),
                embedding_model: None,
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
                chat_model: Some("a\u{0}b".into()),
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
    }
}
