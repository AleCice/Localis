import type { LibraryDocument } from "../../api/types";
import { formatBytes, formatDate } from "../../lib/format";
import { KIND_LABEL } from "./labels";
import { StatusLabel } from "./StatusLabel";

export const documentRowId = (id: string) => `doc-row-${id}`;

interface DocumentListProps {
  documents: LibraryDocument[];
  selectedId: string | null;
  onOpen: (doc: LibraryDocument) => void;
  /** Present only for documents whose current version has a failed job. */
  onRetry: (doc: LibraryDocument) => void;
  canRetry: (doc: LibraryDocument) => boolean;
  retrying: Set<string>;
}

/** Plain list of rows (not cards): open button + discreet metadata and text status. */
export function DocumentList({ documents, selectedId, onOpen, onRetry, canRetry, retrying }: DocumentListProps) {
  return (
    <ul className="doc-list" aria-label="Documenti">
      {documents.map((doc) => {
        const v = doc.current;
        const versions = doc.versionCount > 1 ? ` · ${doc.versionCount} versioni` : "";
        return (
          <li key={doc.id} className="doc-row" aria-current={doc.id === selectedId ? "true" : undefined}>
            <button
              type="button"
              id={documentRowId(doc.id)}
              className="doc-open"
              onClick={() => onOpen(doc)}
              title={doc.title}
            >
              <span className="doc-title">{doc.title}</span>
              <span className="doc-meta">
                {KIND_LABEL[v.kind]} · {formatBytes(v.sizeBytes)} ·{" "}
                <time dateTime={doc.updatedAt}>{formatDate(doc.updatedAt)}</time>
                {versions}
              </span>
            </button>
            {v.textStatus === "extracted" ? null : (
              <StatusLabel
                status={v.textStatus}
                title={doc.title}
                onRetry={canRetry(doc) ? () => onRetry(doc) : undefined}
                retrying={retrying.has(doc.id)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
