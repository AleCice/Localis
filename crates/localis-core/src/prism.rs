//! PRISM: picks the chat model for a question, deterministically, with a reason in Italian.
//!
//! - `manual`: the configured chat model (a cloud model in a local-only project is refused
//!   with `consent_required`).
//! - `auto`, over the ordered candidates: privacy (a local-only project keeps LM Studio
//!   candidates only) → availability (local: LM Studio answers and lists the model; cloud:
//!   the provider has a key) → the first available local candidate wins → otherwise the
//!   cheapest cloud candidate by the user's prices (input + output per million tokens),
//!   unpriced ones after, in list order → nothing available: `llm_unavailable`.
//!
//! A cloud choice always goes through the user's confirmation (see `cloud_send`).

use crate::error::{CoreError, Result};
use crate::prices::ModelPrice;
use crate::providers::{CloudPolicy, CloudProvider, ModelRef, ProviderId};
use crate::settings::{LlmSettings, Routing};

pub const NO_CHAT_MODEL: &str =
    "Nessun modello di chat selezionato. Scegline uno in Impostazioni o nell'intestazione della chat.";
pub const LOCAL_ONLY_CLOUD_MODEL: &str = "Questo progetto è «Solo locale»: il modello di chat scelto è un modello cloud. Scegli un modello di LM Studio oppure consenti l'uso del cloud nel progetto.";
pub const MANUAL_REASON: &str = "Scelto manualmente nelle impostazioni.";

/// The decision for one question (`RouteDecision` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteDecision {
    pub model: ModelRef,
    pub cloud: bool,
    pub reason: String,
}

/// What LM Studio reported, asked only when a local candidate needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalModels {
    Reachable(Vec<String>),
    Unreachable,
}

/// Facts PRISM needs besides the settings. `local` is called at most once, and only when
/// there is a local candidate.
pub struct RouteInputs<'a> {
    pub policy: CloudPolicy,
    pub local: &'a mut dyn FnMut() -> LocalModels,
    pub has_key: &'a dyn Fn(CloudProvider) -> bool,
    pub prices: &'a [ModelPrice],
}

/// Decides the chat model for a question. Pure apart from the two callbacks.
pub fn route(settings: &LlmSettings, inputs: RouteInputs<'_>) -> Result<RouteDecision> {
    match settings.routing {
        Routing::Manual => {
            let Some(model) = settings.chat_model.clone() else {
                return Err(CoreError::llm(NO_CHAT_MODEL, "no chat model configured"));
            };
            if model.is_cloud() && inputs.policy == CloudPolicy::LocalOnly {
                return Err(CoreError::consent(LOCAL_ONLY_CLOUD_MODEL));
            }
            Ok(RouteDecision {
                cloud: model.is_cloud(),
                model,
                reason: MANUAL_REASON.to_owned(),
            })
        }
        Routing::Auto => route_auto(&settings.auto_models, inputs),
    }
}

fn route_auto(candidates: &[ModelRef], inputs: RouteInputs<'_>) -> Result<RouteDecision> {
    let none = |why: &str| {
        CoreError::llm(
            format!("Nessun modello disponibile: {why}."),
            "automatic routing found no available candidate",
        )
    };
    if candidates.is_empty() {
        return Err(none("l'elenco dei modelli candidati è vuoto"));
    }
    let local_only = inputs.policy == CloudPolicy::LocalOnly;
    let locals: Vec<&ModelRef> = candidates
        .iter()
        .filter(|m| m.provider == ProviderId::LmStudio)
        .collect();
    // Why no local candidate was chosen (for the reason and for the error).
    let local_note = if locals.is_empty() {
        "nessun modello locale tra i candidati".to_owned()
    } else {
        match (inputs.local)() {
            LocalModels::Unreachable => "LM Studio non è raggiungibile".to_owned(),
            LocalModels::Reachable(ids) => {
                if let Some(m) = locals.iter().find(|m| ids.contains(&m.model)) {
                    return Ok(RouteDecision {
                        model: (*m).clone(),
                        cloud: false,
                        reason: format!(
                            "Scelto automaticamente: {} è disponibile in LM Studio e i modelli locali hanno sempre la precedenza.",
                            m.model
                        ),
                    });
                }
                "i modelli locali candidati non sono disponibili in LM Studio".to_owned()
            }
        }
    };
    if local_only {
        return Err(none(&format!("il progetto è «Solo locale» e {local_note}")));
    }
    let clouds: Vec<(usize, &ModelRef, CloudProvider)> = candidates
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.provider.cloud().map(|p| (i, m, p)))
        .collect();
    if clouds.is_empty() {
        return Err(none(&format!(
            "{local_note} e non ci sono modelli cloud tra i candidati"
        )));
    }
    let available: Vec<(usize, &ModelRef)> = clouds
        .iter()
        .filter(|(_, _, p)| (inputs.has_key)(*p))
        .map(|(i, m, _)| (*i, *m))
        .collect();
    if available.is_empty() {
        return Err(none(&format!(
            "{local_note} e nessun provider cloud candidato ha una chiave API"
        )));
    }
    let price_of = |m: &ModelRef| {
        let p = m.provider.cloud()?;
        inputs
            .prices
            .iter()
            .find(|x| x.provider == p && x.model == m.model)
    };
    // Prices in different currencies are not comparable: only those in the currency of the
    // first priced candidate (list order) are ranked by price; the others count as unpriced.
    let currency = available
        .iter()
        .find_map(|(_, m)| price_of(m).map(|x| x.currency.clone()));
    let price = |m: &ModelRef| -> Option<f64> {
        price_of(m)
            .filter(|x| Some(&x.currency) == currency.as_ref())
            .map(|x| x.input_per_mtok + x.output_per_mtok)
    };
    let mut ranked: Vec<(usize, &ModelRef, Option<f64>)> =
        available.iter().map(|(i, m)| (*i, *m, price(m))).collect();
    // Priced first by price (ties: list order), then unpriced in list order.
    ranked.sort_by(|a, b| match (a.2, b.2) {
        (Some(x), Some(y)) => x.total_cmp(&y).then(a.0.cmp(&b.0)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.0.cmp(&b.0),
    });
    let (_, model, priced) = ranked[0];
    let why = if priced.is_some() {
        format!(
            "{} ({}) è il modello cloud più economico tra quelli consentiti, secondo i prezzi inseriti",
            model.model,
            model.provider.name()
        )
    } else {
        format!(
            "{} ({}) è il primo modello cloud disponibile nell'elenco (nessun prezzo impostato)",
            model.model,
            model.provider.name()
        )
    };
    Ok(RouteDecision {
        model: model.clone(),
        cloud: true,
        reason: format!("Scelto automaticamente: {local_note}; {why}."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPENAI: ProviderId = ProviderId::Cloud(CloudProvider::OpenAi);
    const GEMINI: ProviderId = ProviderId::Cloud(CloudProvider::Gemini);
    const DEEPSEEK: ProviderId = ProviderId::Cloud(CloudProvider::DeepSeek);

    fn auto(models: &[(ProviderId, &str)]) -> LlmSettings {
        LlmSettings {
            routing: Routing::Auto,
            auto_models: models.iter().map(|(p, m)| ModelRef::new(*p, m)).collect(),
            ..LlmSettings::default()
        }
    }

    fn price(p: CloudProvider, m: &str, i: f64, o: f64) -> ModelPrice {
        ModelPrice {
            provider: p,
            model: m.into(),
            input_per_mtok: i,
            output_per_mtok: o,
            currency: "USD".into(),
        }
    }

    struct Case {
        policy: CloudPolicy,
        local: LocalModels,
        keys: Vec<CloudProvider>,
        prices: Vec<ModelPrice>,
    }

    impl Case {
        fn new() -> Self {
            Case {
                policy: CloudPolicy::CloudAllowed,
                local: LocalModels::Reachable(vec!["qwen".into()]),
                keys: CloudProvider::ALL.to_vec(),
                prices: Vec::new(),
            }
        }

        fn run(&self, settings: &LlmSettings) -> (Result<RouteDecision>, usize) {
            let mut calls = 0;
            let local = self.local.clone();
            let mut local_fn = || {
                calls += 1;
                local.clone()
            };
            let has_key = |p: CloudProvider| self.keys.contains(&p);
            let r = route(
                settings,
                RouteInputs {
                    policy: self.policy,
                    local: &mut local_fn,
                    has_key: &has_key,
                    prices: &self.prices,
                },
            );
            (r, calls)
        }
    }

    #[test]
    fn manual_branches() {
        let case = Case::new();
        let (r, calls) = case.run(&LlmSettings::default());
        assert_eq!(r.unwrap_err().to_string(), NO_CHAT_MODEL);
        assert_eq!(calls, 0, "manual never contacts LM Studio");
        let s = LlmSettings {
            chat_model: Some(ModelRef::new(OPENAI, "gpt")),
            ..LlmSettings::default()
        };
        let d = case.run(&s).0.unwrap();
        assert!(d.cloud);
        assert_eq!(d.reason, MANUAL_REASON);
        let local_only = Case {
            policy: CloudPolicy::LocalOnly,
            ..Case::new()
        };
        let err = local_only.run(&s).0.unwrap_err();
        assert_eq!(err.code(), "consent_required");
        let s = LlmSettings {
            chat_model: Some(ModelRef::lmstudio("qwen")),
            ..LlmSettings::default()
        };
        assert!(!local_only.run(&s).0.unwrap().cloud);
    }

    #[test]
    fn local_preference_wins_when_available() {
        let s = auto(&[
            (OPENAI, "gpt"),
            (ProviderId::LmStudio, "absent"),
            (ProviderId::LmStudio, "qwen"),
        ]);
        let (r, calls) = Case::new().run(&s);
        let d = r.unwrap();
        assert_eq!(d.model, ModelRef::lmstudio("qwen"));
        assert!(!d.cloud);
        assert!(d.reason.contains("precedenza"), "{}", d.reason);
        assert_eq!(calls, 1);
    }

    #[test]
    fn no_local_candidates_skip_lm_studio() {
        let (r, calls) = Case::new().run(&auto(&[(OPENAI, "gpt")]));
        assert!(r
            .unwrap()
            .reason
            .contains("nessun modello locale tra i candidati"));
        assert_eq!(calls, 0);
    }

    #[test]
    fn privacy_keeps_local_only_projects_local() {
        let s = auto(&[(OPENAI, "gpt"), (ProviderId::LmStudio, "qwen")]);
        let case = Case {
            policy: CloudPolicy::LocalOnly,
            ..Case::new()
        };
        assert_eq!(case.run(&s).0.unwrap().model, ModelRef::lmstudio("qwen"));
        let case = Case {
            policy: CloudPolicy::LocalOnly,
            local: LocalModels::Unreachable,
            ..Case::new()
        };
        let err = case.run(&s).0.unwrap_err();
        assert_eq!(err.code(), "llm_unavailable");
        assert!(err.to_string().starts_with("Nessun modello disponibile: il progetto è «Solo locale» e LM Studio non è raggiungibile"), "{err}");
        let err = case.run(&auto(&[(OPENAI, "gpt")])).0.unwrap_err();
        assert_eq!(err.code(), "llm_unavailable");
    }

    #[test]
    fn availability_requires_keys_and_listed_local_models() {
        let s = auto(&[
            (ProviderId::LmStudio, "missing"),
            (OPENAI, "gpt"),
            (GEMINI, "g"),
        ]);
        let case = Case {
            keys: vec![CloudProvider::Gemini],
            ..Case::new()
        };
        let d = case.run(&s).0.unwrap();
        assert_eq!(d.model, ModelRef::new(GEMINI, "g"));
        assert!(
            d.reason.contains("non sono disponibili in LM Studio"),
            "{}",
            d.reason
        );
        assert!(d.reason.contains("nessun prezzo"), "{}", d.reason);
        let case = Case {
            keys: vec![],
            local: LocalModels::Unreachable,
            ..Case::new()
        };
        let err = case.run(&s).0.unwrap_err();
        assert!(
            err.to_string()
                .contains("nessun provider cloud candidato ha una chiave API"),
            "{err}"
        );
        let err = Case::new()
            .run(&auto(&[(ProviderId::LmStudio, "missing")]))
            .0
            .unwrap_err();
        assert!(
            err.to_string().contains("non ci sono modelli cloud"),
            "{err}"
        );
    }

    #[test]
    fn prices_in_different_currencies_are_not_compared() {
        let s = auto(&[(OPENAI, "gpt"), (GEMINI, "flash")]);
        // gpt is priced in EUR (first priced candidate in list order), flash in USD and
        // numerically cheaper: the USD price must not win against the EUR one.
        let mut eur = price(CloudProvider::OpenAi, "gpt", 5.0, 10.0);
        eur.currency = "EUR".into();
        let case = Case {
            local: LocalModels::Unreachable,
            prices: vec![eur, price(CloudProvider::Gemini, "flash", 0.1, 0.2)],
            ..Case::new()
        };
        let d = case.run(&s).0.unwrap();
        assert_eq!(d.model.model, "gpt");
    }

    #[test]
    fn cost_order_then_list_order() {
        let s = auto(&[(OPENAI, "a"), (GEMINI, "b"), (DEEPSEEK, "c"), (OPENAI, "d")]);
        let case = Case {
            prices: vec![
                price(CloudProvider::Gemini, "b", 1.0, 4.0),
                price(CloudProvider::DeepSeek, "c", 0.5, 1.0),
                price(CloudProvider::OpenAi, "d", 0.5, 1.0),
            ],
            ..Case::new()
        };
        let d = case.run(&s).0.unwrap();
        assert_eq!(
            d.model,
            ModelRef::new(DEEPSEEK, "c"),
            "cheapest; tie broken by list order"
        );
        assert!(d.reason.contains("più economico"));
        // Same inputs, same answer.
        for _ in 0..5 {
            assert_eq!(case.run(&s).0.unwrap(), d);
        }
        // Without the DeepSeek key the tie partner wins.
        let case = Case {
            keys: vec![CloudProvider::OpenAi, CloudProvider::Gemini],
            ..case
        };
        assert_eq!(case.run(&s).0.unwrap().model, ModelRef::new(OPENAI, "d"));
        // Unpriced only: list order.
        let case = Case::new();
        assert_eq!(case.run(&s).0.unwrap().model, ModelRef::new(OPENAI, "a"));
        let err = Case::new().run(&auto(&[])).0.unwrap_err();
        assert!(err.to_string().contains("vuoto"));
    }
}
