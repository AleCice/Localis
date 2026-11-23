import { forwardRef, type ReactNode } from "react";
import type { ChatMessage, Source } from "../../api/types";
import { CloseIcon } from "../../components/Icons";
import { formatMoney, formatUsage, providerName } from "../../lib/models";
import { SCOPE_REASON_LABEL, unitLabel, VIA_LABEL } from "./labels";
import { citedSources } from "./Sources";

interface InspectorProps {
  message: ChatMessage | null;
  /** Title of a project document by id (null when it no longer exists). */
  documentTitle: (id: string) => string | null;
  onOpenSource: (source: Source) => void;
  onClose: () => void;
  overlay: boolean;
}

export const INSPECTOR_ID = "chat-inspector";

function Tier({ title, items, onOpen, empty }: { title: string; items: Source[]; onOpen: (s: Source) => void; empty: string }) {
  return (
    <section className="inspector-tier" aria-label={title}>
      <h3 className="inspector-subtitle">
        {title} <span className="muted">({items.length})</span>
      </h3>
      {items.length === 0 ? (
        <p className="hint">{empty}</p>
      ) : (
        <ol className="inspector-list">
          {items.map((s) => (
            <li key={`${s.rank}-${s.n ?? "r"}`}>
              <InspectorSource source={s} onOpen={onOpen} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function InspectorSource({ source, onOpen }: { source: Source; onOpen: (s: Source) => void }) {
  const label = (
    <>
      <span className="inspector-rank">{source.n != null ? `[${source.n}]` : `#${source.rank}`}</span>
      <span className="inspector-src-title">{source.title}</span>
      <span className="inspector-src-meta">
        {unitLabel(source.unitKind, source.unit, source.startMs)} · {VIA_LABEL[source.via]}
        {source.available ? "" : " · non più disponibile"}
      </span>
    </>
  );
  if (!source.available) return <div className="inspector-src is-missing">{label}</div>;
  return (
    <button type="button" className="inspector-src" onClick={() => onOpen(source)}>
      {label}
    </button>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Retrieval details of one answer: mode, scope, model, query and the three source tiers. */
export const Inspector = forwardRef<HTMLElement, InspectorProps>(function Inspector(
  { message, documentTitle, onOpenSource, onClose, overlay },
  ref,
) {
  const retrieval = message?.retrieval ?? null;
  const sources = message?.sources ?? [];
  const raw = [...sources].sort((a, b) => a.rank - b.rank);
  const evidence = sources.filter((s) => s.n != null).sort((a, b) => a.n! - b.n!);
  const cited = citedSources(sources);

  return (
    <aside
      id={INSPECTOR_ID}
      ref={ref}
      className={overlay ? "inspector is-overlay" : "inspector"}
      aria-labelledby="inspector-title"
      tabIndex={-1}
    >
      <div className="inspector-head">
        <h2 id="inspector-title" className="inspector-title">
          Dettagli della risposta
        </h2>
        <button type="button" className="icon-btn icon-btn-sm" aria-label="Chiudi dettagli" title="Chiudi dettagli" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {!message ? (
        <p className="hint">Nessuna risposta selezionata.</p>
      ) : !retrieval ? (
        <p className="hint">
          {message.kind === "inventory"
            ? "Elenco costruito da Localis con i documenti del progetto: nessuna ricerca e nessun modello."
            : message.kind === "clarification"
              ? "La domanda poteva riferirsi a più documenti: nessuna ricerca eseguita."
              : "Per questa risposta non ci sono dettagli di ricerca."}
        </p>
      ) : (
        <>
          <dl className="inspector-facts">
            <Row term="Modalità">
              {retrieval.mode === "hybrid" ? (
                <>
                  Ibrida{" "}
                  <span className="muted">
                    (lessicale + semantica
                    {retrieval.embeddingModel
                      ? ` · ${retrieval.embeddingProvider && retrieval.embeddingProvider !== "lmstudio" ? `${providerName(retrieval.embeddingProvider)} · ` : ""}${retrieval.embeddingModel}`
                      : ""}
                    )
                  </span>
                </>
              ) : (
                "Lessicale"
              )}
            </Row>
            <Row term="Ambito">
              {retrieval.scope === "project" ? (
                "Tutto il progetto"
              ) : (
                <>
                  <ul className="inspector-docs">
                    {retrieval.documentIds.map((id) => (
                      <li key={id}>{documentTitle(id) ?? <span className="muted">Documento non più disponibile</span>}</li>
                    ))}
                  </ul>
                  {retrieval.scopeReason ? (
                    <span className="muted">Motivo: {SCOPE_REASON_LABEL[retrieval.scopeReason]}</span>
                  ) : null}
                </>
              )}
            </Row>
            <Row term="Modello di chat">
              {message.model ? (
                <>
                  <span>{message.model}</span> <span className="muted">· {providerName(message.provider ?? "lmstudio")}</span>
                </>
              ) : (
                <span className="muted">Nessuno</span>
              )}
            </Row>
            {message.routeReason ? <Row term="Scelta del modello">{message.routeReason}</Row> : null}
            {formatUsage(message.usage) || message.cost ? (
              <Row term="Uso">
                {[formatUsage(message.usage), message.cost ? formatMoney(message.cost) : null].filter(Boolean).join(" · ")}
              </Row>
            ) : null}
            <Row term="Query lessicale">
              {retrieval.query ? <code className="inspector-query">{retrieval.query}</code> : <span className="muted">—</span>}
            </Row>
          </dl>
          <Tier title="Risultati grezzi" items={raw} onOpen={onOpenSource} empty="Nessun risultato." />
          <Tier title="Evidenze nel prompt" items={evidence} onOpen={onOpenSource} empty="Nessuna evidenza passata al modello." />
          <Tier title="Citate" items={cited} onOpen={onOpenSource} empty="Nessuna fonte citata." />
        </>
      )}
    </aside>
  );
});
