import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { AppError, EmbeddingStatus, LlmSettings, Project } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { chatModels, embeddingModels, useLlm } from "../../hooks/useLlm";

/** Interval between embedding status checks while indexing runs. */
export const EMBEDDING_POLL_MS = 2000;

const EMBEDDING_STATE_LABEL: Record<EmbeddingStatus["state"], string> = {
  disabled: "Non attiva: nessun modello di embedding",
  idle: "Completata",
  running: "In corso",
  unreachable: "In attesa di LM Studio",
};

function useEmbeddingStatus(projectId: string | null, key: string | null) {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let alive = true;
    api.getEmbeddingStatus(projectId).then(
      (value) => {
        if (!alive) return;
        setStatus(value);
        setError(null);
      },
      (err: unknown) => alive && setError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [projectId, key, tick]);

  // Poll only while indexing is running.
  useEffect(() => {
    if (status?.state !== "running") return;
    const timer = window.setTimeout(() => setTick((t) => t + 1), EMBEDDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [status]);

  return { status, error };
}

interface ModelSelectProps {
  label: string;
  value: string | null;
  options: { id: string; label: string }[];
  /** Label of the empty choice; when absent the empty choice is a disabled placeholder. */
  noneLabel?: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
  hint?: string;
}

function ModelSelect({ label, value, options, noneLabel, disabled, onChange, hint }: ModelSelectProps) {
  const id = useId();
  const current = value ?? "";
  const missing = current !== "" && !options.some((o) => o.id === current);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="select"
        value={current}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        aria-describedby={hint ? `${id}-hint` : undefined}
      >
        {noneLabel ? (
          <option value="">{noneLabel}</option>
        ) : current === "" ? (
          <option value="" disabled>
            Scegli un modello
          </option>
        ) : null}
        {missing ? <option value={current}>{current} (non trovato in LM Studio)</option> : null}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** «Modelli locali (LM Studio)» settings: URL, connection, chat and embedding models, indexing state. */
export function LlmSettingsSection({ project }: { project: Project | null }) {
  const llm = useLlm();
  const { settings, status, checking } = llm;
  const urlId = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [savingUrl, setSavingUrl] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  // Read once the settings are known, and again when the embedding model changes.
  const embedding = useEmbeddingStatus(settings ? (project?.id ?? null) : null, settings?.embeddingModel ?? null);

  useEffect(() => {
    if (settings) setUrl(settings.baseUrl);
  }, [settings?.baseUrl]);

  const save = useCallback(
    async (next: LlmSettings, what: string, urlChange = false) => {
      setSaveError(null);
      setSaved(null);
      try {
        await llm.save(next);
        setSaved(what);
        return true;
      } catch (err) {
        const error = toAppError(err);
        // URL errors are shown at the field (the backend validates: loopback http only).
        if (error.field === "baseUrl" || (urlChange && error.code === "validation")) {
          setUrlError(error.message);
          requestAnimationFrame(() => urlRef.current?.focus());
        } else {
          setSaveError(error);
        }
        return false;
      }
    },
    [llm],
  );

  const submitUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || savingUrl) return;
    setUrlError(null);
    setSavingUrl(true);
    const ok = await save({ ...settings, baseUrl: url.trim() }, "Indirizzo salvato.", true);
    setSavingUrl(false);
    if (ok) void llm.recheck();
  };

  const llmOptions = chatModels(status).map((m) => ({
    id: m.id,
    label: m.state === "not-loaded" ? `${m.id} (non caricato)` : m.id,
  }));
  const embeddingOptions = embeddingModels(status).map((m) => ({
    id: m.id,
    label: m.state === "not-loaded" ? `${m.id} (non caricato)` : m.id,
  }));
  const unreachable = status !== null && !status.reachable;

  return (
    <section className="settings-group llm-settings" aria-labelledby="llm-settings-title">
      <h2 id="llm-settings-title" className="settings-title">
        Modelli locali (LM Studio)
      </h2>
      <p className="hint">
        I documenti e le conversazioni restano su questo computer. Localis comunica solo con LM Studio in esecuzione su
        questo computer, all'indirizzo indicato qui sotto.
      </p>

      {llm.loadError ? <ErrorBanner error={llm.loadError} /> : null}

      {settings ? (
        <>
          <form className="field url-field" onSubmit={submitUrl} noValidate>
            <label htmlFor={urlId}>Indirizzo del server di LM Studio</label>
            <div className="inline-row">
              <input
                id={urlId}
                ref={urlRef}
                type="text"
                inputMode="url"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setUrlError(null);
                }}
                aria-invalid={urlError ? true : undefined}
                aria-describedby={urlError ? `${urlId}-error` : `${urlId}-hint`}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="btn btn-secondary" disabled={savingUrl || url.trim() === settings.baseUrl}>
                {savingUrl ? <Spinner /> : null}
                Salva
              </button>
            </div>
            {urlError ? (
              <p id={`${urlId}-error`} className="field-error">
                {urlError}
              </p>
            ) : (
              <p id={`${urlId}-hint`} className="hint">
                Solo indirizzi di questo computer, ad esempio http://127.0.0.1:1234.
              </p>
            )}
          </form>

          <div className="llm-status">
            <p className="llm-status-line" role="status">
              {checking ? (
                <>
                  <Spinner /> Verifica in corso…
                </>
              ) : status?.reachable ? (
                <>
                  <span className="dot is-on" aria-hidden="true" />
                  Connesso a LM Studio · {status.models.length === 1 ? "1 modello" : `${status.models.length} modelli`}
                </>
              ) : status ? (
                <>
                  <span className="dot" aria-hidden="true" />
                  {status.message ?? "LM Studio non è raggiungibile."}
                </>
              ) : null}
            </p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void llm.recheck()} disabled={checking}>
              Verifica connessione
            </button>
          </div>
          {unreachable ? (
            <p className="hint">Avvia LM Studio e il suo server locale, poi premi «Verifica connessione».</p>
          ) : null}

          <ModelSelect
            label="Modello di chat"
            value={settings.chatModel}
            options={llmOptions}
            disabled={!status?.reachable}
            onChange={(value) => void save({ ...settings, chatModel: value }, "Modello di chat salvato.")}
            hint={status?.reachable && llmOptions.length === 0 ? "LM Studio non riporta modelli di chat." : undefined}
          />
          <ModelSelect
            label="Modello di embedding"
            value={settings.embeddingModel}
            options={embeddingOptions}
            noneLabel="Nessuno — solo ricerca lessicale"
            disabled={!status?.reachable}
            onChange={(value) => void save({ ...settings, embeddingModel: value }, "Modello di embedding salvato.")}
            hint="Con un modello di embedding la ricerca considera anche il significato dei passaggi, oltre alle parole."
          />
          {saveError ? <ErrorBanner error={saveError} /> : null}
          <p className="hint" role="status">
            {saved ?? ""}
          </p>

          <div className="embedding-status">
            <h3 className="settings-subtitle">Indicizzazione semantica{project ? ` · ${project.name}` : ""}</h3>
            {!project ? (
              <p className="hint">Seleziona un progetto per vedere lo stato dell'indicizzazione.</p>
            ) : embedding.error ? (
              <ErrorBanner error={embedding.error} />
            ) : embedding.status ? (
              <>
                <p>
                  {EMBEDDING_STATE_LABEL[embedding.status.state]}
                  {embedding.status.state === "running" ? <Spinner /> : null}
                </p>
                {embedding.status.state !== "disabled" ? (
                  <p className="muted">
                    Passaggi indicizzati: {embedding.status.embedded} di {embedding.status.total}
                    {embedding.status.model ? ` · ${embedding.status.model}` : ""}
                  </p>
                ) : null}
                {embedding.status.message ? <p className="hint">{embedding.status.message}</p> : null}
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
