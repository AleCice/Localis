import { useId, useRef, useState, type FormEvent } from "react";
import type { AppError, CloudProviderId, ModelPrice } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { useCloud } from "../../hooks/useCloud";
import { CLOUD_PROVIDERS, formatDecimal, parsePrice, providerName } from "../../lib/models";

type Field = "model" | "input" | "output" | "currency";

interface Draft {
  provider: CloudProviderId;
  model: string;
  input: string;
  output: string;
  currency: string;
}

const EMPTY: Draft = { provider: "openai", model: "", input: "", output: "", currency: "USD" };

function validate(draft: Draft): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  if (!draft.model.trim()) errors.model = "Inserisci l'identificativo del modello, come lo riporta il provider.";
  if (parsePrice(draft.input) === null) errors.input = "Inserisci un numero non negativo, ad esempio 2,50.";
  if (parsePrice(draft.output) === null) errors.output = "Inserisci un numero non negativo, ad esempio 10.";
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim()))
    errors.currency = "Usa un codice di tre lettere, ad esempio USD o EUR.";
  return errors;
}

/** «Prezzi»: user-entered prices per million tokens; Localis ships none. */
export function PricesSection() {
  const cloud = useCloud();
  const id = useId();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [announce, setAnnounce] = useState("");
  const refs = {
    model: useRef<HTMLInputElement>(null),
    input: useRef<HTMLInputElement>(null),
    output: useRef<HTMLInputElement>(null),
    currency: useRef<HTMLInputElement>(null),
  };
  const providers = cloud.providers?.map((p) => p.id) ?? CLOUD_PROVIDERS;
  const knownModels = cloud.models[draft.provider]?.result?.models.map((m) => m.id) ?? [];

  const change = (field: keyof Draft, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    if (field !== "provider") setErrors((e) => ({ ...e, [field]: undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const found = validate(draft);
    setErrors(found);
    setSaveError(null);
    setAnnounce("");
    const first = (["model", "input", "output", "currency"] as Field[]).find((f) => found[f]);
    if (first) {
      refs[first].current?.focus();
      return;
    }
    const price: ModelPrice = {
      provider: draft.provider,
      model: draft.model.trim(),
      inputPerMTok: parsePrice(draft.input)!,
      outputPerMTok: parsePrice(draft.output)!,
      currency: draft.currency.trim().toUpperCase(),
    };
    setSaving(true);
    try {
      await cloud.store.setPrice(price);
      setDraft({ ...EMPTY, provider: draft.provider, currency: price.currency });
      setAnnounce(`Prezzo di ${price.model} salvato.`);
    } catch (err) {
      const error = toAppError(err);
      const field = error.field === "inputPerMTok" ? "input" : error.field === "outputPerMTok" ? "output" : error.field;
      if (field && field in refs) {
        setErrors({ [field]: error.message });
        refs[field as Field].current?.focus();
      } else {
        setSaveError(error);
      }
    } finally {
      setSaving(false);
    }
  };

  const edit = (price: ModelPrice) => {
    setDraft({
      provider: price.provider,
      model: price.model,
      input: formatDecimal(price.inputPerMTok),
      output: formatDecimal(price.outputPerMTok),
      currency: price.currency,
    });
    setErrors({});
    requestAnimationFrame(() => refs.input.current?.focus());
  };

  const remove = async (price: ModelPrice) => {
    setSaveError(null);
    try {
      await cloud.store.deletePrice(price.provider, price.model);
      setAnnounce(`Prezzo di ${price.model} rimosso.`);
    } catch (err) {
      setSaveError(toAppError(err));
    }
  };

  const fieldProps = (field: Field) => ({
    id: `${id}-${field}`,
    ref: refs[field],
    "aria-invalid": errors[field] ? true : undefined,
    "aria-describedby": errors[field] ? `${id}-${field}-error` : undefined,
    autoComplete: "off",
    spellCheck: false,
  });
  const fieldError = (field: Field) =>
    errors[field] ? (
      <p id={`${id}-${field}-error`} className="field-error">
        {errors[field]}
      </p>
    ) : null;

  const prices = cloud.prices ?? [];

  return (
    <section className="settings-group prices-settings" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="settings-title">
        Prezzi
      </h2>
      <p className="hint">
        Localis non conosce i prezzi: inseriscili dal listino del provider. Servono per stimare il costo prima di ogni
        invio e per calcolarlo dopo la risposta; senza prezzo il costo resta «non stimabile».
      </p>

      {prices.length > 0 ? (
        <div className="table-scroll">
          <table className="data-table">
            <caption className="visually-hidden">Prezzi per milione di token</caption>
            <thead>
              <tr>
                <th scope="col">Modello</th>
                <th scope="col" className="num">
                  Input / M token
                </th>
                <th scope="col" className="num">
                  Output / M token
                </th>
                <th scope="col">
                  <span className="visually-hidden">Azioni</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={`${p.provider}:${p.model}`}>
                  <td>
                    <span className="cell-strong">{p.model}</span>
                    <span className="muted"> · {providerName(p.provider)}</span>
                  </td>
                  <td className="num">
                    {formatDecimal(p.inputPerMTok)} {p.currency}
                  </td>
                  <td className="num">
                    {formatDecimal(p.outputPerMTok)} {p.currency}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => edit(p)}
                      aria-label={`Modifica il prezzo di ${p.model}`}
                    >
                      Modifica
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-danger-text"
                      onClick={() => void remove(p)}
                      aria-label={`Rimuovi il prezzo di ${p.model}`}
                    >
                      Rimuovi
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Nessun prezzo inserito.</p>
      )}

      <form className="price-form" onSubmit={submit} noValidate aria-label="Prezzo di un modello">
        <div className="field">
          <label htmlFor={`${id}-provider`}>Provider</label>
          <select
            id={`${id}-provider`}
            className="select"
            value={draft.provider}
            onChange={(e) => change("provider", e.target.value)}
          >
            {providers.map((p) => (
              <option key={p} value={p}>
                {cloud.providers?.find((x) => x.id === p)?.name ?? providerName(p)}
              </option>
            ))}
          </select>
        </div>
        <div className="field price-model">
          <label htmlFor={`${id}-model`}>Modello</label>
          <input
            {...fieldProps("model")}
            type="text"
            list={knownModels.length > 0 ? `${id}-models` : undefined}
            value={draft.model}
            onChange={(e) => change("model", e.target.value)}
          />
          {knownModels.length > 0 ? (
            <datalist id={`${id}-models`}>
              {knownModels.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          ) : null}
          {fieldError("model")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-input`}>Input per milione di token</label>
          <input
            {...fieldProps("input")}
            type="text"
            inputMode="decimal"
            value={draft.input}
            onChange={(e) => change("input", e.target.value)}
          />
          {fieldError("input")}
        </div>
        <div className="field">
          <label htmlFor={`${id}-output`}>Output per milione di token</label>
          <input
            {...fieldProps("output")}
            type="text"
            inputMode="decimal"
            value={draft.output}
            onChange={(e) => change("output", e.target.value)}
          />
          {fieldError("output")}
        </div>
        <div className="field price-currency">
          <label htmlFor={`${id}-currency`}>Valuta</label>
          <input
            {...fieldProps("currency")}
            type="text"
            maxLength={3}
            value={draft.currency}
            onChange={(e) => change("currency", e.target.value)}
          />
          {fieldError("currency")}
        </div>
        <div className="price-actions">
          <button type="submit" className="btn btn-secondary" disabled={saving}>
            {saving ? <Spinner /> : null}
            Salva prezzo
          </button>
        </div>
      </form>
      {saveError ? <ErrorBanner error={saveError} /> : null}
      <p className="visually-hidden" role="status">
        {announce}
      </p>
    </section>
  );
}
