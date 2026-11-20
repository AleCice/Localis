import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AppError, CloudPurpose, CloudRequest } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { formatDateTimeShort } from "../../lib/format";
import { formatCount, formatMoney, providerName } from "../../lib/models";

export const PURPOSE_LABEL: Record<CloudPurpose, string> = {
  chat: "Domanda in chat",
  query_embedding: "Embedding della domanda",
  index_embedding: "Indicizzazione",
  list_models: "Elenco modelli",
};

const ACTIVITY_LIMIT = 100;

function tokens(r: CloudRequest): string {
  if (!r.usage || (r.usage.inputTokens == null && r.usage.outputTokens == null)) return "—";
  const input = r.usage.inputTokens != null ? formatCount(r.usage.inputTokens) : "—";
  const output = r.usage.outputTokens != null ? formatCount(r.usage.outputTokens) : "—";
  return `${input} / ${output}`;
}

/** «Attività cloud»: local log of every request sent to a provider (never its content). */
export function CloudActivitySection() {
  const [items, setItems] = useState<CloudRequest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AppError | null>(null);
  const showLoading = useDelayedFlag(loading && items === null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await Promise.resolve().then(() => api.listCloudRequests(ACTIVITY_LIMIT)));
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="settings-group activity-settings" aria-labelledby="cloud-activity-title">
      <div className="settings-head">
        <h2 id="cloud-activity-title" className="settings-title">
          Attività cloud
        </h2>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void load()}
          disabled={loading}
          aria-busy={loading || undefined}
        >
          Aggiorna
        </button>
      </div>
      <p className="hint">
        Registro locale delle richieste inviate ai provider cloud: quantità e costi, mai il contenuto né le chiavi.
        Ultime {ACTIVITY_LIMIT}.
      </p>
      {error ? <ErrorBanner error={error} action={{ label: "Riprova", onClick: () => void load() }} /> : null}
      {showLoading ? (
        <p className="loading" role="status">
          <Spinner />
          Caricamento…
        </p>
      ) : null}
      {items && items.length === 0 ? <p className="muted">Nessuna richiesta inviata ai provider cloud.</p> : null}
      {items && items.length > 0 ? (
        <div className="table-scroll" tabIndex={0} aria-labelledby="cloud-activity-title">
          <table className="data-table activity-table">
            <caption className="visually-hidden">Richieste ai provider cloud, dalla più recente</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Provider</th>
                <th scope="col">Modello</th>
                <th scope="col">Scopo</th>
                <th scope="col" className="num">
                  Caratteri
                </th>
                <th scope="col" className="num">
                  Token (in / out)
                </th>
                <th scope="col" className="num">
                  Costo
                </th>
                <th scope="col">Esito</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <time dateTime={r.createdAt}>{formatDateTimeShort(r.createdAt)}</time>
                  </td>
                  <td>{providerName(r.provider)}</td>
                  <td className="cell-break">{r.model ?? "—"}</td>
                  <td>{PURPOSE_LABEL[r.purpose]}</td>
                  <td className="num">{formatCount(r.charsSent)}</td>
                  <td className="num">{tokens(r)}</td>
                  <td className="num">{r.cost ? formatMoney(r.cost) : "—"}</td>
                  <td className="cell-break">{r.ok ? "Riuscita" : `Non riuscita${r.error ? `: ${r.error}` : ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
