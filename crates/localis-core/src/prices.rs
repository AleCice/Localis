//! User-entered model prices (Localis ships none: they change and cannot be verified
//! here), token usage, estimates and costs.

use rusqlite::{params, OptionalExtension};

use crate::error::{CoreError, Result};
use crate::providers::{CloudProvider, ModelRef};
use crate::settings::validate_model_id;
use crate::store::{now, Store};

/// Largest accepted price per million tokens.
pub const PRICE_MAX: f64 = 1_000_000.0;
/// Characters per token of the rough estimate shown before sending.
pub const CHARS_PER_TOKEN: u64 = 4;

const PRICE_INVALID: &str = "Inserisci un prezzo valido (un numero maggiore o uguale a zero).";
const CURRENCY_INVALID: &str = "La valuta deve essere un codice di 3 lettere (es. USD, EUR).";

/// Token usage as reported by a provider (`TokenUsage` in `src/api/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

impl Usage {
    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none() && self.output_tokens.is_none()
    }

    /// Later reports override earlier ones, field by field.
    pub(crate) fn merge(&mut self, other: Usage) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
    }
}

/// An amount in the currency entered by the user (`Money` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct Money {
    pub amount: f64,
    pub currency: String,
}

/// Price per million tokens (`ModelPrice` in `src/api/types.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct ModelPrice {
    pub provider: CloudProvider,
    pub model: String,
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
    pub currency: String,
}

impl ModelPrice {
    /// Cost of `input` + `output` tokens.
    pub fn cost(&self, input: u64, output: u64) -> Money {
        Money {
            amount: (input as f64 * self.input_per_mtok + output as f64 * self.output_per_mtok)
                / 1_000_000.0,
            currency: self.currency.clone(),
        }
    }

    /// Cost of a reported usage; `None` unless the provider reported the tokens needed.
    pub fn cost_of(&self, usage: &Usage, needs_output: bool) -> Option<Money> {
        let input = usage.input_tokens?;
        let output = match usage.output_tokens {
            Some(o) => o,
            None if !needs_output => 0,
            None => return None,
        };
        Some(self.cost(input, output))
    }
}

/// Rough token estimate: characters / 4, rounded up.
pub fn estimate_tokens(chars: u64) -> u64 {
    chars.div_ceil(CHARS_PER_TOKEN)
}

fn validate_amount(x: f64, field: &'static str) -> Result<f64> {
    if !x.is_finite() || !(0.0..=PRICE_MAX).contains(&x) {
        return Err(CoreError::validation(field, PRICE_INVALID));
    }
    Ok(x)
}

/// Validates a price entered by the user; the currency is normalized to uppercase.
pub fn validate_price(input: &ModelPrice) -> Result<ModelPrice> {
    let currency = input.currency.trim().to_ascii_uppercase();
    if currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
        return Err(CoreError::validation("currency", CURRENCY_INVALID));
    }
    Ok(ModelPrice {
        provider: input.provider,
        model: validate_model_id(&input.model, "model")?,
        input_per_mtok: validate_amount(input.input_per_mtok, "inputPerMTok")?,
        output_per_mtok: validate_amount(input.output_per_mtok, "outputPerMTok")?,
        currency,
    })
}

fn row_to_price(r: &rusqlite::Row<'_>) -> rusqlite::Result<Option<ModelPrice>> {
    let provider: String = r.get(0)?;
    let (model, input_per_mtok, output_per_mtok, currency) =
        (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
    Ok(CloudProvider::parse(&provider).map(|provider| ModelPrice {
        provider,
        model,
        input_per_mtok,
        output_per_mtok,
        currency,
    }))
}

impl Store {
    /// All prices, by provider then model.
    pub fn list_prices(&self) -> Result<Vec<ModelPrice>> {
        let mut stmt = self.conn.prepare(
            "SELECT provider, model, input_per_mtok, output_per_mtok, currency
             FROM model_prices ORDER BY provider, model",
        )?;
        let rows = stmt.query_map([], row_to_price)?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect())
    }

    /// Price of a model; `None` for LM Studio and for models without a price.
    pub fn price_of(&self, model: &ModelRef) -> Result<Option<ModelPrice>> {
        let Some(provider) = model.provider.cloud() else {
            return Ok(None);
        };
        Ok(self
            .conn
            .query_row(
                "SELECT provider, model, input_per_mtok, output_per_mtok, currency
                 FROM model_prices WHERE provider = ?1 AND model = ?2",
                params![provider.as_str(), model.model],
                row_to_price,
            )
            .optional()?
            .flatten())
    }

    /// Inserts or replaces a price; returns all prices.
    pub fn set_price(&mut self, input: &ModelPrice) -> Result<Vec<ModelPrice>> {
        let p = validate_price(input)?;
        let now = now(&self.conn)?;
        self.conn.execute(
            "INSERT INTO model_prices (provider, model, input_per_mtok, output_per_mtok,
                 currency, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (provider, model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok,
                 output_per_mtok = excluded.output_per_mtok, currency = excluded.currency,
                 updated_at = excluded.updated_at",
            params![
                p.provider.as_str(),
                p.model,
                p.input_per_mtok,
                p.output_per_mtok,
                p.currency,
                now
            ],
        )?;
        self.list_prices()
    }

    /// Removes a price (no-op when missing); returns all prices.
    pub fn delete_price(
        &mut self,
        provider: CloudProvider,
        model: &str,
    ) -> Result<Vec<ModelPrice>> {
        self.conn.execute(
            "DELETE FROM model_prices WHERE provider = ?1 AND model = ?2",
            params![provider.as_str(), model.trim()],
        )?;
        self.list_prices()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(i: f64, o: f64, cur: &str) -> ModelPrice {
        ModelPrice {
            provider: CloudProvider::OpenAi,
            model: " gpt-x ".into(),
            input_per_mtok: i,
            output_per_mtok: o,
            currency: cur.into(),
        }
    }

    #[test]
    fn prices_crud_and_validation() {
        let mut store = Store::open_in_memory().unwrap();
        assert!(store.list_prices().unwrap().is_empty());
        let list = store.set_price(&price(2.5, 10.0, "usd")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].model, "gpt-x");
        assert_eq!(list[0].currency, "USD");
        let list = store.set_price(&price(1.0, 0.0, "EUR")).unwrap();
        assert_eq!(list.len(), 1, "upsert");
        assert_eq!(list[0].input_per_mtok, 1.0);
        for (bad, field) in [
            (price(-1.0, 1.0, "USD"), "inputPerMTok"),
            (price(f64::NAN, 1.0, "USD"), "inputPerMTok"),
            (price(1.0, f64::INFINITY, "USD"), "outputPerMTok"),
            (price(1.0, PRICE_MAX * 2.0, "USD"), "outputPerMTok"),
            (price(1.0, 1.0, "US"), "currency"),
            (price(1.0, 1.0, "U$D"), "currency"),
            (price(1.0, 1.0, "€"), "currency"),
        ] {
            let err = store.set_price(&bad).unwrap_err();
            assert!(
                matches!(err, CoreError::Validation { field: f, .. } if f == field),
                "{err:?}"
            );
        }
        let gpt = ModelRef::new(crate::providers::ProviderId::Cloud(CloudProvider::OpenAi), "gpt-x");
        assert!(store.price_of(&gpt).unwrap().is_some());
        assert!(store.price_of(&ModelRef::lmstudio("gpt-x")).unwrap().is_none());
        assert!(store
            .delete_price(CloudProvider::OpenAi, "gpt-x")
            .unwrap()
            .is_empty());
        assert!(store.delete_price(CloudProvider::OpenAi, "gpt-x").is_ok());
    }

    #[test]
    fn costs_and_estimates() {
        let p = validate_price(&price(2.0, 8.0, "USD")).unwrap();
        let c = p.cost(1_000_000, 500_000);
        assert!((c.amount - 6.0).abs() < 1e-9);
        assert_eq!(c.currency, "USD");
        let usage = Usage {
            input_tokens: Some(1000),
            output_tokens: None,
        };
        assert_eq!(p.cost_of(&usage, true), None);
        assert!((p.cost_of(&usage, false).unwrap().amount - 0.002).abs() < 1e-12);
        assert_eq!(p.cost_of(&Usage::default(), false), None);
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(1), 1);
        assert_eq!(estimate_tokens(8), 2);
        assert_eq!(estimate_tokens(9), 3);
        let mut u = Usage {
            input_tokens: Some(5),
            output_tokens: Some(1),
        };
        u.merge(Usage {
            input_tokens: None,
            output_tokens: Some(7),
        });
        assert_eq!((u.input_tokens, u.output_tokens), (Some(5), Some(7)));
    }
}
