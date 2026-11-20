import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { LlmStore } from "../../hooks/useLlm";
import { toAppError, type AppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";

/** «Modelli locali (LM Studio)»: server address and connection state. */
export function LmStudioSection({ llm }: { llm: LlmStore }) {
  const { settings, status, checking } = llm;
  const urlId = useId();
  const urlRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [savingUrl, setSavingUrl] = useState(false);
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    if (settings) setUrl(settings.baseUrl);
  }, [settings?.baseUrl]);

  const submitUrl = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings || savingUrl) return;
    setUrlError(null);
    setSaveError(null);
    setSaved("");
    setSavingUrl(true);
    try {
      await llm.save({ ...settings, baseUrl: url.trim() });
      setSaved("Indirizzo salvato.");
      void llm.recheck();
    } catch (err) {
      const error = toAppError(err);
      // The backend validates (loopback http only): its message belongs at the field.
      if (error.field === "baseUrl" || error.code === "validation") {
        setUrlError(error.message);
        requestAnimationFrame(() => urlRef.current?.focus());
      } else {
        setSaveError(error);
      }
    } finally {
      setSavingUrl(false);
    }
  };

  const unreachable = status !== null && !status.reachable;

  return (
    <section className="settings-group llm-settings" aria-labelledby="llm-settings-title">
      <h2 id="llm-settings-title" className="settings-title">
        Modelli locali (LM Studio)
      </h2>
      <p className="hint">
        Con LM Studio i documenti e le conversazioni restano su questo computer: Localis comunica solo con il server
        locale all'indirizzo indicato qui sotto.
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
              <button
                type="submit"
                className="btn btn-secondary"
                disabled={savingUrl || url.trim() === settings.baseUrl}
              >
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
          {saveError ? <ErrorBanner error={saveError} /> : null}
          <p className="hint" role="status">
            {saved}
          </p>

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
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void llm.recheck()}
              disabled={checking}
            >
              Verifica connessione
            </button>
          </div>
          {unreachable ? (
            <p className="hint">Avvia LM Studio e il suo server locale, poi premi «Verifica connessione».</p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
