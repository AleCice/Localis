import type { AppError, LibraryDocument } from "../../api/types";
import { CloseIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { formatBytes } from "../../lib/format";

export type ImportOutcome =
  | { name: string; kind: "imported"; document: LibraryDocument }
  | { name: string; kind: "duplicate"; document: LibraryDocument }
  | { name: string; kind: "error"; error: AppError }
  /** v0.5: stopped with «Annulla» (nothing kept). */
  | { name: string; kind: "cancelled" };

/** v0.5: transfer of the file being imported in chunks. */
export interface ImportProgress {
  name: string;
  sentBytes: number;
  totalBytes: number;
}

export interface ImportState {
  running: boolean;
  total: number;
  outcomes: ImportOutcome[];
  folderLabel: string;
  /** Chunked transfer in progress (audio/video and large files). */
  progress?: ImportProgress | null;
}

interface ImportSummaryProps {
  state: ImportState;
  onOpen: (doc: LibraryDocument) => void;
  onDismiss: () => void;
  /** Stops the import (current transfer discarded, remaining files skipped). */
  onCancel?: () => void;
}

function summaryLine(outcomes: ImportOutcome[]): string {
  const imported = outcomes.filter((o) => o.kind === "imported").length;
  const duplicates = outcomes.filter((o) => o.kind === "duplicate").length;
  const errors = outcomes.filter((o) => o.kind === "error").length;
  const parts: string[] = [];
  if (imported) parts.push(imported === 1 ? "1 importato" : `${imported} importati`);
  if (duplicates) parts.push(duplicates === 1 ? "1 già presente" : `${duplicates} già presenti`);
  if (errors) parts.push(errors === 1 ? "1 non importato" : `${errors} non importati`);
  const cancelled = outcomes.filter((o) => o.kind === "cancelled").length;
  if (cancelled) parts.push(cancelled === 1 ? "1 annullato" : `${cancelled} annullati`);
  return parts.join(", ");
}

/** Per-file outcome of an import: imported, already present, or error with details on demand. */
/** Percent shown and announced in steps of 10 (screen readers are not flooded on every chunk). */
function percentOf(progress: ImportProgress): number {
  return progress.totalBytes > 0 ? Math.min(100, Math.floor((progress.sentBytes / progress.totalBytes) * 100)) : 0;
}

export function ImportSummary({ state, onOpen, onDismiss, onCancel }: ImportSummaryProps) {
  const { running, total, outcomes, folderLabel, progress } = state;
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
        {running && onCancel ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Annulla
          </button>
        ) : null}
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
      {running && progress ? (
        <div className="import-progress">
          <span className="import-name" title={progress.name}>
            {progress.name}
          </span>
          <progress max={100} value={percentOf(progress)} aria-label={`Importazione di ${progress.name}`} />
          <span className="hint import-bytes">
            {percentOf(progress)} % · {formatBytes(progress.sentBytes)} di {formatBytes(progress.totalBytes)}
          </span>
          <span className="visually-hidden" role="status">
            {`${progress.name}: ${Math.floor(percentOf(progress) / 10) * 10} %`}
          </span>
        </div>
      ) : null}
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
              ) : outcome.kind === "cancelled" ? (
                <span className="import-result">Annullato</span>
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
