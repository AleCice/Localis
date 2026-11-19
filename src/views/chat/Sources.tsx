import type { Source } from "../../api/types";
import { excerpt, unitLabel } from "./labels";

interface SourcesProps {
  sources: Source[];
  onOpen: (source: Source) => void;
}

export function citedSources(sources: Source[]): Source[] {
  return sources.filter((s) => s.cited && s.n != null).sort((a, b) => a.n! - b.n!);
}

/** Passed to the model but not cited in the answer. */
export function consultedSources(sources: Source[]): Source[] {
  return sources.filter((s) => !s.cited && s.n != null).sort((a, b) => a.n! - b.n!);
}

export function SourceItem({ source, onOpen, showN = true }: { source: Source; onOpen: (s: Source) => void; showN?: boolean }) {
  const head = (
    <>
      <span className="source-head">
        {showN && source.n != null ? <span className="source-n">[{source.n}]</span> : null}
        <span className="source-title">{source.title}</span>
        <span className="source-unit">{unitLabel(source.unitKind, source.unit)}</span>
      </span>
      {source.available ? null : <span className="source-missing">Documento non più disponibile</span>}
      <span className="source-snippet">{excerpt(source.text)}</span>
    </>
  );
  if (!source.available) return <div className="source-item is-missing">{head}</div>;
  return (
    <button type="button" className="source-item" onClick={() => onOpen(source)}>
      {head}
    </button>
  );
}

/** Compact, collapsed-by-default source lists under an answer (raw results live in the inspector). */
export function Sources({ sources, onOpen }: SourcesProps) {
  const cited = citedSources(sources);
  const consulted = consultedSources(sources);
  if (cited.length === 0 && consulted.length === 0) return null;
  return (
    <div className="sources">
      {cited.length > 0 ? (
        <details className="sources-group">
          <summary>Fonti citate ({cited.length})</summary>
          <ul className="source-list">
            {cited.map((s) => (
              <li key={`${s.rank}-${s.n}`}>
                <SourceItem source={s} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {consulted.length > 0 ? (
        <details className="sources-group">
          <summary>Fonti consultate ({consulted.length})</summary>
          <ul className="source-list">
            {consulted.map((s) => (
              <li key={`${s.rank}-${s.n}`}>
                <SourceItem source={s} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
