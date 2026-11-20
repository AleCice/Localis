import { useId, useRef, useState, type FormEvent } from "react";
import type { AppError, CloudProviderId, ModelInfo, ProviderInfo } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { useCloud, type Cloud } from "../../hooks/useCloud";
import { formatCount } from "../../lib/models";

const KIND_LABEL: Record<ModelInfo["kind"], string> = {
  llm: "chat",
  embedding: "embedding",
  unknown: "tipo non indicato",
};

/** «Provider cloud»: keychain state, API keys and model lists per provider. */
export function CloudProvidersSection() {
  const cloud = useCloud();
  const [removing, setRemoving] = useState<ProviderInfo | null>(null);
  const keyringOff = cloud.keyring !== null && !cloud.keyring.available;

  return (
    <section className="settings-group cloud-settings" aria-labelledby="cloud-settings-title">
      <h2 id="cloud-settings-title" className="settings-title">
        Provider cloud
      </h2>
      <p className="hint">
        Facoltativi. Ogni progetto nasce «Solo locale»; un progetto con il cloud consentito invia una domanda a un
        provider solo dopo che hai visto e confermato cosa viene inviato.
      </p>

      {cloud.loadError ? (
        <ErrorBanner error={cloud.loadError} action={{ label: "Riprova", onClick: () => void cloud.store.reload() }} />
      ) : null}

      {cloud.keyring ? (
        cloud.keyring.available ? (
          <p className="llm-status-line">
            <span className="dot is-on" aria-hidden="true" />
            Le chiavi API vengono salvate nel portachiavi di sistema, mai nel database di Localis.
          </p>
        ) : (
          <div className="notice keyring-off" role="note">
            <p>{cloud.keyring.message ?? "Il portachiavi di sistema non è disponibile."}</p>
            <p className="hint">
              Senza portachiavi Localis non salva chiavi API (non esiste un'alternativa in chiaro): i provider cloud
              restano inutilizzabili, i modelli locali funzionano normalmente.
            </p>
            {cloud.keyring.detail ? (
              <details className="banner-details">
                <summary>Dettagli</summary>
                <pre>{cloud.keyring.detail}</pre>
              </details>
            ) : null}
          </div>
        )
      ) : null}

      {cloud.providers ? (
        <ul className="provider-list">
          {cloud.providers.map((p) => (
            <li key={p.id}>
              <ProviderItem provider={p} cloud={cloud} keyringOff={keyringOff} onRemove={() => setRemoving(p)} />
            </li>
          ))}
        </ul>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`Rimuovere la chiave di ${removing?.name ?? ""}?`}
        confirmLabel="Rimuovi chiave"
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await cloud.store.deleteKey(removing.id);
          setRemoving(null);
        }}
        focusAfterConfirm={() => (removing ? document.getElementById(keyInputId(removing.id)) : null)}
      >
        <p>
          La chiave viene eliminata dal portachiavi di sistema. Conversazioni e registro restano; per usare di nuovo{" "}
          {removing?.name} dovrai inserire una nuova chiave.
        </p>
      </ConfirmDialog>
    </section>
  );
}

const keyInputId = (id: CloudProviderId) => `api-key-${id}`;

function ProviderItem({
  provider,
  cloud,
  keyringOff,
  onRemove,
}: {
  provider: ProviderInfo;
  cloud: Cloud;
  keyringOff: boolean;
  onRemove: () => void;
}) {
  const titleId = useId();
  const inputId = keyInputId(provider.id);
  // Uncontrolled on purpose: the key never enters React state or a DOM attribute.
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [keyError, setKeyError] = useState<AppError | null>(null);
  const [announce, setAnnounce] = useState("");
  const models = cloud.models[provider.id];
  const showForm = !provider.hasKey || replacing;

  const clearField = () => {
    if (inputRef.current) inputRef.current.value = "";
    setHasValue(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const key = inputRef.current?.value.trim() ?? "";
    if (saving) return;
    if (!key) {
      setKeyError({ code: "validation", field: "key", message: "Incolla la chiave API." });
      inputRef.current?.focus();
      return;
    }
    setSaving(true);
    setKeyError(null);
    setAnnounce("");
    try {
      await cloud.store.setKey(provider.id, key);
      clearField();
      setReplacing(false);
      setAnnounce(`Chiave di ${provider.name} salvata nel portachiavi.`);
    } catch (err) {
      const error = err as AppError;
      // A key that cannot be stored is not kept in the field either.
      if (error.code === "keyring_unavailable") clearField();
      setKeyError(error);
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setSaving(false);
    }
  };

  const capabilities =
    provider.supportsChat && provider.supportsEmbeddings
      ? "Chat ed embedding"
      : provider.supportsEmbeddings
        ? "Embedding"
        : "Chat";

  return (
    <section className="provider" aria-labelledby={titleId}>
      <div className="provider-head">
        <h3 id={titleId} className="settings-subtitle">
          {provider.name}
        </h3>
        <span className="muted provider-host">
          {provider.host} · {capabilities}
        </span>
      </div>

      {provider.hasKey ? (
        <div className="provider-key">
          <p className="llm-status-line">
            <span className="dot is-on" aria-hidden="true" />
            Chiave salvata nel portachiavi
          </p>
          {!replacing ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setReplacing(true)}
              disabled={keyringOff}
            >
              Sostituisci chiave
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm btn-danger-text" onClick={onRemove}>
            Rimuovi chiave
          </button>
        </div>
      ) : null}

      {showForm ? (
        <form className="field" onSubmit={submit} noValidate>
          <label htmlFor={inputId}>
            {provider.hasKey ? `Nuova chiave API di ${provider.name}` : `Chiave API di ${provider.name}`}
          </label>
          <div className="inline-row">
            <input
              id={inputId}
              ref={inputRef}
              type="password"
              name={`localis-api-key-${provider.id}`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={keyringOff || saving}
              onInput={(e) => setHasValue(e.currentTarget.value.trim() !== "")}
              aria-invalid={keyError ? true : undefined}
              aria-describedby={keyError ? `${inputId}-error` : `${inputId}-hint`}
            />
            <button type="submit" className="btn btn-secondary" disabled={keyringOff || saving || !hasValue}>
              {saving ? <Spinner /> : null}
              Salva
            </button>
            {replacing ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  clearField();
                  setKeyError(null);
                  setReplacing(false);
                }}
              >
                Annulla
              </button>
            ) : null}
          </div>
          {keyError ? (
            <p id={`${inputId}-error`} className="field-error">
              {keyError.message}
            </p>
          ) : (
            <p id={`${inputId}-hint`} className="hint">
              {keyringOff
                ? "Portachiavi non disponibile: la chiave non può essere salvata."
                : "La chiave va nel portachiavi di sistema; dopo il salvataggio non viene più mostrata."}
            </p>
          )}
        </form>
      ) : null}
      <p className="visually-hidden" role="status">
        {announce}
      </p>

      <div className="provider-models">
        <div className="inline-row provider-models-head">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!provider.hasKey || models?.loading}
            aria-busy={models?.loading || undefined}
            aria-describedby={`${inputId}-models-hint`}
            onClick={() => void cloud.store.loadModels(provider.id)}
          >
            {models?.loading ? <Spinner /> : null}
            Carica modelli
          </button>
          <span id={`${inputId}-models-hint`} className="hint">
            {provider.hasKey
              ? `Contatta ${provider.host} con la tua chiave per ottenere l'elenco dei modelli.`
              : "Serve una chiave API."}
          </span>
        </div>
        {models?.error ? <ErrorBanner error={models.error} /> : null}
        {models?.result && !models.result.reachable ? (
          <ErrorBanner
            error={{
              code: "llm_unavailable",
              message: models.result.message ?? `${provider.name} non raggiungibile.`,
              detail: models.result.detail ?? undefined,
            }}
          />
        ) : null}
        {models?.result?.reachable ? (
          models.result.models.length === 0 ? (
            <p className="hint">{provider.name} non riporta modelli.</p>
          ) : (
            <details className="provider-model-list" open>
              <summary>
                {models.result.models.length === 1
                  ? "1 modello"
                  : `${formatCount(models.result.models.length)} modelli`}
              </summary>
              <ul>
                {models.result.models.map((m) => (
                  <li key={m.id}>
                    <span className="provider-model-id">{m.id}</span>{" "}
                    <span className="muted">· {KIND_LABEL[m.kind]}</span>
                  </li>
                ))}
              </ul>
            </details>
          )
        ) : null}
      </div>
    </section>
  );
}
