//! Model providers known to Localis: LM Studio on loopback and five cloud providers with
//! fixed hosts. No cloud URL is configurable by the user.
//!
//! Cloud requests go only to `https://<host>` from [`CloudProvider::host`], with certificate
//! verification (rustls + the platform verifier), redirects disabled and the system proxy
//! taken from the environment (`HTTPS_PROXY`, `NO_PROXY`…). LM Studio keeps `proxy(None)`.
//!
//! **Test-only override.** In builds with `debug_assertions` (never in release builds: the
//! code is compiled out), `LOCALIS_TEST_<PROVIDER>_BASE_URL` (e.g.
//! `LOCALIS_TEST_OPENAI_BASE_URL=http://127.0.0.1:4010`) replaces the origin of a provider
//! with a loopback `http` URL, for end-to-end tests against fake servers.

use std::time::Duration;

use crate::error::{CoreError, Result};

/// Connection timeout of cloud requests.
pub const CLOUD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const PROVIDER_INVALID: &str = "Provider non valido.";

/// Any model provider (`ProviderId` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ProviderId {
    LmStudio,
    Cloud(CloudProvider),
}

/// A cloud provider (`CloudProviderId` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum CloudProvider {
    OpenAi,
    Anthropic,
    Gemini,
    DeepSeek,
    Qwen,
}

impl CloudProvider {
    /// In the order shown to the user.
    pub const ALL: [CloudProvider; 5] = [
        CloudProvider::OpenAi,
        CloudProvider::Anthropic,
        CloudProvider::Gemini,
        CloudProvider::DeepSeek,
        CloudProvider::Qwen,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            CloudProvider::OpenAi => "openai",
            CloudProvider::Anthropic => "anthropic",
            CloudProvider::Gemini => "gemini",
            CloudProvider::DeepSeek => "deepseek",
            CloudProvider::Qwen => "qwen",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        CloudProvider::ALL.into_iter().find(|p| p.as_str() == s)
    }

    /// Like [`CloudProvider::parse`], as a `validation` error on `field`.
    pub fn parse_field(s: &str, field: &'static str) -> Result<Self> {
        Self::parse(s).ok_or_else(|| CoreError::validation(field, PROVIDER_INVALID))
    }

    /// Display name.
    pub fn name(self) -> &'static str {
        match self {
            CloudProvider::OpenAi => "OpenAI",
            CloudProvider::Anthropic => "Anthropic",
            CloudProvider::Gemini => "Google Gemini",
            CloudProvider::DeepSeek => "DeepSeek",
            CloudProvider::Qwen => "Qwen (Alibaba Cloud)",
        }
    }

    /// The only host Localis contacts for this provider.
    pub fn host(self) -> &'static str {
        match self {
            CloudProvider::OpenAi => "api.openai.com",
            CloudProvider::Anthropic => "api.anthropic.com",
            CloudProvider::Gemini => "generativelanguage.googleapis.com",
            CloudProvider::DeepSeek => "api.deepseek.com",
            CloudProvider::Qwen => "dashscope-intl.aliyuncs.com",
        }
    }

    /// Path prefix of the API on the host.
    pub(crate) fn path_prefix(self) -> &'static str {
        match self {
            CloudProvider::OpenAi => "/v1",
            CloudProvider::Anthropic => "/v1",
            CloudProvider::Gemini => "/v1beta",
            CloudProvider::DeepSeek => "",
            CloudProvider::Qwen => "/compatible-mode/v1",
        }
    }

    pub fn supports_chat(self) -> bool {
        true
    }

    pub fn supports_embeddings(self) -> bool {
        matches!(
            self,
            CloudProvider::OpenAi | CloudProvider::Gemini | CloudProvider::Qwen
        )
    }

    /// Max texts per embedding request.
    pub(crate) fn embed_batch_max(self) -> usize {
        match self {
            CloudProvider::OpenAi => 64,
            CloudProvider::Gemini => 64,
            // DashScope compatible mode accepts at most 10 inputs per request.
            CloudProvider::Qwen => 10,
            CloudProvider::Anthropic | CloudProvider::DeepSeek => 1,
        }
    }
}

impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::LmStudio => "lmstudio",
            ProviderId::Cloud(c) => c.as_str(),
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        if s == "lmstudio" {
            return Some(ProviderId::LmStudio);
        }
        CloudProvider::parse(s).map(ProviderId::Cloud)
    }

    pub fn cloud(self) -> Option<CloudProvider> {
        match self {
            ProviderId::LmStudio => None,
            ProviderId::Cloud(c) => Some(c),
        }
    }

    pub fn is_cloud(self) -> bool {
        self.cloud().is_some()
    }

    pub fn name(self) -> &'static str {
        match self {
            ProviderId::LmStudio => "LM Studio",
            ProviderId::Cloud(c) => c.name(),
        }
    }

    pub fn supports_embeddings(self) -> bool {
        match self {
            ProviderId::LmStudio => true,
            ProviderId::Cloud(c) => c.supports_embeddings(),
        }
    }
}

/// A model on a provider (`ModelRef` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ModelRef {
    pub provider: ProviderId,
    /// Id as reported by the provider.
    pub model: String,
}

impl ModelRef {
    pub fn new(provider: ProviderId, model: &str) -> Self {
        ModelRef {
            provider,
            model: model.to_owned(),
        }
    }

    pub fn lmstudio(model: &str) -> Self {
        Self::new(ProviderId::LmStudio, model)
    }

    /// Key under which embeddings of this model are stored: `provider:model`.
    pub fn embedding_key(&self) -> String {
        format!("{}:{}", self.provider.as_str(), self.model)
    }

    pub fn is_cloud(&self) -> bool {
        self.provider.is_cloud()
    }
}

/// Whether a project may send anything to cloud providers (`CloudPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CloudPolicy {
    /// Default: nothing of the project ever reaches a cloud provider.
    #[default]
    LocalOnly,
    CloudAllowed,
}

impl CloudPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            CloudPolicy::LocalOnly => "local_only",
            CloudPolicy::CloudAllowed => "cloud_allowed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "local_only" => Some(CloudPolicy::LocalOnly),
            "cloud_allowed" => Some(CloudPolicy::CloudAllowed),
            _ => None,
        }
    }
}

/// Origins of the cloud providers. In release builds always the fixed `https://<host>`;
/// in debug builds a provider can be pointed at a loopback fake server (tests only).
#[derive(Debug, Clone, Default)]
pub struct Endpoints {
    #[cfg(debug_assertions)]
    overrides: std::collections::HashMap<CloudProvider, String>,
}

impl Endpoints {
    /// The fixed hosts; in debug builds, plus the `LOCALIS_TEST_<PROVIDER>_BASE_URL`
    /// overrides found in the environment (invalid ones are ignored with a warning).
    pub fn from_env() -> Self {
        #[allow(unused_mut)]
        let mut endpoints = Endpoints::default();
        #[cfg(debug_assertions)]
        for provider in CloudProvider::ALL {
            let var = test_override_var(provider);
            if let Ok(value) = std::env::var(var) {
                match endpoints.clone().with_test_override(provider, &value) {
                    Ok(e) => endpoints = e,
                    Err(_) => eprintln!("localis: ignoring {var}: not a loopback http URL"),
                }
            }
        }
        endpoints
    }

    /// Debug builds only: points `provider` at a loopback `http` origin (a fake server).
    /// Anything else is rejected.
    #[cfg(debug_assertions)]
    pub fn with_test_override(mut self, provider: CloudProvider, origin: &str) -> Result<Self> {
        let origin = crate::settings::validate_base_url(origin)?;
        self.overrides.insert(provider, origin);
        Ok(self)
    }

    /// Whether `provider` is overridden (always false in release builds).
    pub fn is_overridden(&self, provider: CloudProvider) -> bool {
        #[cfg(debug_assertions)]
        {
            self.overrides.contains_key(&provider)
        }
        #[cfg(not(debug_assertions))]
        {
            let _ = provider;
            false
        }
    }

    fn origin(&self, provider: CloudProvider) -> String {
        #[cfg(debug_assertions)]
        if let Some(o) = self.overrides.get(&provider) {
            return o.clone();
        }
        format!("https://{}", provider.host())
    }

    /// Full URL of `path` (starting with `/`) on the provider's API, checked against the
    /// allowlist.
    pub fn url(&self, provider: CloudProvider, path: &str) -> Result<String> {
        let url = format!("{}{}{path}", self.origin(provider), provider.path_prefix());
        self.check_url(provider, &url)?;
        Ok(url)
    }

    /// Defense in depth before every cloud request: the URL must be `https://` on the
    /// provider's fixed host (or, in debug builds, the provider's loopback override).
    pub fn check_url(&self, provider: CloudProvider, url: &str) -> Result<()> {
        let refuse = || {
            CoreError::Internal(format!(
                "refused request to a host outside the allowlist for {}",
                provider.as_str()
            ))
        };
        #[cfg(debug_assertions)]
        if let Some(origin) = self.overrides.get(&provider) {
            return match url.strip_prefix(origin.as_str()) {
                Some(rest) if rest.starts_with('/') => Ok(()),
                _ => Err(refuse()),
            };
        }
        check_https_host(url, provider.host()).ok_or_else(refuse)
    }
}

/// `Some(())` when `url` is exactly `https://<host>/…` (no port, user info or other host).
pub fn check_https_host(url: &str, host: &str) -> Option<()> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    (authority.eq_ignore_ascii_case(host) && rest[end..].starts_with('/')).then_some(())
}

#[cfg(debug_assertions)]
fn test_override_var(provider: CloudProvider) -> &'static str {
    match provider {
        CloudProvider::OpenAi => "LOCALIS_TEST_OPENAI_BASE_URL",
        CloudProvider::Anthropic => "LOCALIS_TEST_ANTHROPIC_BASE_URL",
        CloudProvider::Gemini => "LOCALIS_TEST_GEMINI_BASE_URL",
        CloudProvider::DeepSeek => "LOCALIS_TEST_DEEPSEEK_BASE_URL",
        CloudProvider::Qwen => "LOCALIS_TEST_QWEN_BASE_URL",
    }
}

/// HTTP agent for cloud requests: HTTPS only with verified certificates, no redirects,
/// proxy from the environment. A loopback test override (debug builds) uses plain http
/// and no proxy.
pub(crate) fn cloud_agent(
    loopback_override: bool,
    total: Option<Duration>,
    per_read: Option<Duration>,
) -> ureq::Agent {
    let builder = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_connect(Some(CLOUD_CONNECT_TIMEOUT))
        .timeout_global(total)
        .timeout_per_read(per_read)
        .user_agent("Localis");
    let builder = if loopback_override {
        builder.proxy(None).https_only(false)
    } else {
        builder
            .proxy(ureq::Proxy::try_from_env())
            .https_only(true)
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
    };
    builder.build().new_agent()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip() {
        for p in CloudProvider::ALL {
            assert_eq!(CloudProvider::parse(p.as_str()), Some(p));
            assert_eq!(ProviderId::parse(p.as_str()), Some(ProviderId::Cloud(p)));
        }
        assert_eq!(ProviderId::parse("lmstudio"), Some(ProviderId::LmStudio));
        assert_eq!(ProviderId::parse("OpenAI"), None);
        assert_eq!(ProviderId::parse(""), None);
        assert_eq!(
            ModelRef::new(ProviderId::Cloud(CloudProvider::Qwen), "text-embedding-v3")
                .embedding_key(),
            "qwen:text-embedding-v3"
        );
    }

    #[test]
    fn fixed_urls_are_https_on_the_allowlisted_host() {
        let e = Endpoints::default();
        assert_eq!(
            e.url(CloudProvider::OpenAi, "/chat/completions").unwrap(),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            e.url(CloudProvider::DeepSeek, "/models").unwrap(),
            "https://api.deepseek.com/models"
        );
        assert_eq!(
            e.url(CloudProvider::Qwen, "/embeddings").unwrap(),
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings"
        );
        assert_eq!(
            e.url(CloudProvider::Gemini, "/models").unwrap(),
            "https://generativelanguage.googleapis.com/v1beta/models"
        );
        assert_eq!(
            e.url(CloudProvider::Anthropic, "/messages").unwrap(),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn allowlist_rejects_other_hosts_schemes_and_tricks() {
        let e = Endpoints::default();
        let p = CloudProvider::OpenAi;
        assert!(e.check_url(p, "https://api.openai.com/v1/models").is_ok());
        for bad in [
            "http://api.openai.com/v1/models",
            "https://api.openai.com.evil.com/v1/models",
            "https://evil.com/api.openai.com/v1",
            "https://api.openai.com@evil.com/v1",
            "https://user@api.openai.com/v1",
            "https://api.openai.com:8443/v1",
            "https://api.anthropic.com/v1/messages",
            "https://api.openai.com",
            "https://api.openai.com?x=/",
            "ftp://api.openai.com/v1",
            "https://127.0.0.1/v1",
        ] {
            assert!(e.check_url(p, bad).is_err(), "{bad}");
        }
        // Each provider only reaches its own host.
        for a in CloudProvider::ALL {
            for b in CloudProvider::ALL {
                let url = format!("https://{}/x", b.host());
                assert_eq!(e.check_url(a, &url).is_ok(), a == b, "{a:?} → {url}");
            }
        }
    }

    // The override exists only in builds with debug assertions (compiled out otherwise).
    #[cfg(debug_assertions)]
    #[test]
    fn test_override_is_loopback_http_only() {
        for bad in [
            "https://127.0.0.1:4010",
            "http://example.com:4010",
            "http://10.0.0.1:4010",
            "http://api.openai.com",
            "http://127.0.0.1:4010/api",
            "http://user@127.0.0.1:4010",
        ] {
            assert!(
                Endpoints::default()
                    .with_test_override(CloudProvider::OpenAi, bad)
                    .is_err(),
                "{bad}"
            );
        }
        let e = Endpoints::default()
            .with_test_override(CloudProvider::Qwen, "http://127.0.0.1:4010/")
            .unwrap();
        assert!(e.is_overridden(CloudProvider::Qwen));
        assert!(!e.is_overridden(CloudProvider::OpenAi));
        assert_eq!(
            e.url(CloudProvider::Qwen, "/models").unwrap(),
            "http://127.0.0.1:4010/compatible-mode/v1/models"
        );
        // The override does not open other hosts for that provider, nor for others.
        assert!(e
            .check_url(CloudProvider::Qwen, "http://127.0.0.1:4011/x")
            .is_err());
        assert!(e
            .check_url(CloudProvider::OpenAi, "http://127.0.0.1:4010/x")
            .is_err());
        assert!(e
            .check_url(CloudProvider::Qwen, "http://127.0.0.1:40100/x")
            .is_err());
    }
}
