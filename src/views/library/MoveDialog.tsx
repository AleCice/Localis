import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AppError, Folder, LibraryDocument } from "../../api/types";
import { toAppError } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { flattenFolders } from "./folders";

interface MoveDialogProps {
  doc: LibraryDocument | null;
  folders: Folder[];
  rootLabel: string;
  onClose: () => void;
  /** Moves the document; rejects with an AppError to keep the dialog open. */
  onMove: (doc: LibraryDocument, folderId: string | null) => Promise<void>;
}

const ROOT = "";

export function MoveDialog({ doc, folders, rootLabel, onClose, onMove }: MoveDialogProps) {
  const [choice, setChoice] = useState<string>(ROOT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const shown = useRef<LibraryDocument | null>(null);
  if (doc) shown.current = doc;
  const target = shown.current;

  useEffect(() => {
    if (!doc) return;
    setChoice(doc.folderId ?? ROOT);
    setError(null);
    setBusy(false);
  }, [doc]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onMove(target, choice === ROOT ? null : choice);
    } catch (err) {
      setError(toAppError(err));
      setBusy(false);
    }
  };

  const options = [
    { id: ROOT, name: rootLabel, depth: 0 },
    ...flattenFolders(folders).map(({ folder, depth }) => ({ id: folder.id, name: folder.name, depth: depth + 1 })),
  ];

  return (
    <Dialog
      open={doc !== null}
      onClose={onClose}
      labelledBy="move-dialog-title"
      dismissDisabled={busy}
      className="dialog-move"
    >
      {target ? (
        <form className="dialog-body" onSubmit={submit} aria-busy={busy}>
          <h2 id="move-dialog-title" className="dialog-title">
            Sposta «{target.title}»
          </h2>
          {error ? <ErrorBanner error={error} /> : null}
          <fieldset className="folder-picker">
            <legend className="visually-hidden">Cartella di destinazione</legend>
            {options.map((option) => (
              <label
                key={option.id || "root"}
                className="folder-choice"
                style={{ paddingInlineStart: `calc(${option.depth} * 1.25rem + 0.5rem)` }}
              >
                <input
                  type="radio"
                  name="move-target"
                  value={option.id}
                  checked={choice === option.id}
                  onChange={() => setChoice(option.id)}
                />
                <span className="folder-choice-name">{option.name}</span>
                {option.id === (target.folderId ?? ROOT) ? <span className="hint">(attuale)</span> : null}
              </label>
            ))}
          </fieldset>
          <div className="dialog-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || choice === (target.folderId ?? ROOT)}>
              {busy ? <Spinner /> : null}
              Sposta
            </button>
          </div>
        </form>
      ) : null}
    </Dialog>
  );
}
