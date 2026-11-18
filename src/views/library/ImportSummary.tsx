import type { AppError, LibraryDocument } from "../../api/types";
import { CloseIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";

export type ImportOutcome =
  | { name: string; kind: "imported"; document: LibraryDocument }
  | { name: string; kind: "duplicate"; document: LibraryDocument }
  | { name: string; kind: "error"; error: AppError };

export interface ImportState {
  running: boolean;
  total: number;
  outcomes: ImportOutcome[];
  folderLabel: string;
}

interface ImportSummaryProps {
  state: ImportState;
  onOpen: (doc: LibraryDocument) => void;
  onDismiss: () => void;
}

function summaryLine(outcomes: ImportOutcome[]): string {
  const imported = outcomes.filter((o) => o.kind === "imported").length;
  const duplicates = outcomes.filter((o) => o.kind === "duplicate").length;
  const errors = outcomes.filter((o) => o.kind === "error").length;
  const parts: string[] = [];
  if (imported) parts.push(imported === 1 ? "1 importato" : `${imported} importati`);
  if (duplicates) parts.push(duplicates === 1 ? "1 già presente" : `${duplicates} già presenti`);
  if (errors) parts.push(errors === 1 ? "1 non importato" : `${errors} non importati`);
  return parts.join(", ");
}

/** Per-file outcome of an import: imported, already present, or error with details on demand. */
export function ImportSummary({ state, onOpen, onDismiss }: ImportSummaryProps) {
  const { running, total, outcomes, folderLabel } = state;
  const hasErrors = outcomes.some((o) => o.kind === "error");
  return (
    <section
      className={hasErrors && !running ? "import-summary has-errors" : "import-summary"}
      aria-label="Importazione"
    >
      <div className="import-summary-head">
        <p className="import-summary-title" role="status">
          {running ? (
            <>
              <Spinner />
              Importazione {Math.min(outcomes.length + 1, total)} di {total} in «{folderLabel}»…
            </>
          ) : (
            <>Importazione completata: {summaryLine(outcomes)}.</>
          )}
        </p>
        {!running ? (
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Chiudi riepilogo importazione"
            title="Chiudi"
            onClick={onDismiss}
          >
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {outcomes.length > 0 ? (
        <ul className="import-list">
          {outcomes.map((outcome, i) => (
            <li key={i} className="import-item" data-kind={outcome.kind}>
              <span className="import-name" title={outcome.name}>
                {outcome.name}
              </span>
              {outcome.kind === "imported" ? (
                <span className="import-result">Importato</span>
              ) : outcome.kind === "duplicate" ? (
                <span className="import-result">
                  Già presente{" "}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => onOpen(outcome.document)}
                    aria-label={`Apri «${outcome.document.title}»`}
                  >
                    Apri
                  </button>
                </span>
              ) : (
                <span className="import-result import-error">
                  {outcome.error.message}
                  {outcome.error.detail ? (
                    <details className="banner-details">
                      <summary>Dettagli</summary>
                      <pre>{outcome.error.detail}</pre>
                    </details>
                  ) : null}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
