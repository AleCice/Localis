import type { AppError, SearchHit } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { parseSnippet } from "../../lib/snippet";
import { formatTimestamp } from "../../lib/time";

interface SearchResultsProps {
  query: string;
  hits: SearchHit[] | null;
  loading: boolean;
  error: AppError | null;
  /** Documents whose text is not in the index (no text, failed, pending, images). */
  excludedCount: number;
  onOpen: (hit: SearchHit) => void;
}

export const unitLabel = (hit: Pick<SearchHit, "unit" | "unitKind" | "startMs">) =>
  hit.unitKind === "segment"
    ? hit.startMs != null
      ? formatTimestamp(hit.startMs)
      : `segmento ${hit.unit}`
    : hit.unitKind === "page"
      ? `p. ${hit.unit}`
      : `blocco ${hit.unit}`;

export function Snippet({ text }: { text: string }) {
  return (
    <>
      {parseSnippet(text).map((part, i) =>
        part.mark ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

export function SearchResults({ query, hits, loading, error, excludedCount, onOpen }: SearchResultsProps) {
  return (
    <section className="search-results" aria-labelledby="search-results-title" aria-busy={loading}>
      <h2 id="search-results-title" className="pane-title">
        Risultati per «{query}»
      </h2>
      {error ? <ErrorBanner error={error} /> : null}
      {loading && !hits ? (
        <p className="loading" role="status">
          <Spinner />
          Ricerca…
        </p>
      ) : null}
      {hits && hits.length === 0 ? (
        <p className="muted" role="status">
          Nessun risultato.
        </p>
      ) : null}
      {hits && hits.length > 0 ? (
        <>
          <p className="visually-hidden" role="status">
            {hits.length === 1 ? "1 risultato" : `${hits.length} risultati`}
          </p>
          <ul className="hit-list">
            {hits.map((hit) => (
              <li key={`${hit.versionId}-${hit.unit}`}>
                <button type="button" className="hit" onClick={() => onOpen(hit)}>
                  <span className="hit-head">
                    <span className="hit-title">{hit.title}</span>
                    <span className="hit-unit">{unitLabel(hit)}</span>
                  </span>
                  <span className="hit-snippet">
                    <Snippet text={hit.snippet} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {excludedCount > 0 && hits ? (
        <p className="hint">
          La ricerca copre solo il testo estratto:{" "}
          {excludedCount === 1 ? "1 documento non è incluso." : `${excludedCount} documenti non sono inclusi.`}
        </p>
      ) : null}
    </section>
  );
}
