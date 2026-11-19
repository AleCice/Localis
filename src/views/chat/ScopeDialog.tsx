import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import type { AppError, LibraryDocument } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { SearchIcon } from "../../components/Icons";
import { STATUS_LABEL } from "../library/labels";

interface ScopeDialogProps {
  open: boolean;
  documents: LibraryDocument[] | null;
  error: AppError | null;
  selected: string[];
  onClose: () => void;
  onApply: (ids: string[]) => void;
}

function normalize(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Picks the project documents a question is limited to. */
export function ScopeDialog({ open, documents, error, selected, onClose, onApply }: ScopeDialogProps) {
  const id = useId();
  const [filter, setFilter] = useState("");
  const [choice, setChoice] = useState<Set<string>>(() => new Set(selected));

  useEffect(() => {
    if (!open) return;
    setFilter("");
    setChoice(new Set(selected));
    // Only when opening: later changes of `selected` must not reset the user's choice.
  }, [open]);

  const visible = useMemo(() => {
    const q = normalize(filter.trim());
    return (documents ?? []).filter((d) => !q || normalize(d.title).includes(q));
  }, [documents, filter]);

  const toggle = (docId: string) =>
    setChoice((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Keep the project order and drop documents that no longer exist.
    onApply((documents ?? []).filter((d) => choice.has(d.id)).map((d) => d.id));
  };

  return (
    <Dialog open={open} onClose={onClose} labelledBy={`${id}-title`} className="dialog-scope">
      <form className="dialog-body" onSubmit={submit}>
        <h2 id={`${id}-title`} className="dialog-title">
          Limita a documenti
        </h2>
        <p className="dialog-text">La prossima domanda cercherà solo nei documenti scelti.</p>
        {error ? <ErrorBanner error={error} /> : null}
        <div className="search-field scope-filter">
          <SearchIcon />
          <input
            type="search"
            aria-label="Filtra documenti"
            placeholder="Filtra documenti"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <fieldset className="folder-picker scope-list">
          <legend className="visually-hidden">Documenti del progetto</legend>
          {documents === null ? (
            <p className="hint">Caricamento…</p>
          ) : documents.length === 0 ? (
            <p className="hint">Il progetto non contiene documenti.</p>
          ) : visible.length === 0 ? (
            <p className="hint">Nessun documento corrisponde al filtro.</p>
          ) : (
            visible.map((doc) => (
              <label key={doc.id} className="folder-choice">
                <input type="checkbox" checked={choice.has(doc.id)} onChange={() => toggle(doc.id)} />
                <span className="folder-choice-name">{doc.title}</span>
                {doc.current.textStatus !== "extracted" ? (
                  <span className="hint">{STATUS_LABEL[doc.current.textStatus]}</span>
                ) : null}
              </label>
            ))
          )}
        </fieldset>
        <div className="dialog-actions">
          {choice.size > 0 ? (
            <button type="button" className="btn btn-ghost scope-clear" onClick={() => setChoice(new Set())}>
              Deseleziona tutti
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Annulla
          </button>
          <button type="submit" className="btn btn-primary">
            {choice.size > 0 ? `Applica (${choice.size})` : "Applica"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
