import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AppError, Folder } from "../../api/types";
import { FOLDER_NAME_MAX, toAppError } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { charCount } from "../../lib/format";

interface FolderNameDialogProps {
  /** null = closed. */
  mode: { kind: "create"; parentName: string | null } | { kind: "rename"; folder: Folder } | null;
  onClose: () => void;
  /** Creates or renames; rejects with an AppError to keep the dialog open. */
  onSubmit: (name: string) => Promise<Folder>;
  onDone: (folder: Folder) => void;
  focusAfterDone: (folder: Folder) => HTMLElement | null;
}

export function FolderNameDialog({ mode, onClose, onSubmit, onDone, focusAfterDone }: FolderNameDialogProps) {
  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef<Folder | null>(null);
  const open = mode !== null;

  useEffect(() => {
    if (!mode) return;
    setName(mode.kind === "rename" ? mode.folder.name : "");
    setFieldError(null);
    setFormError(null);
    setBusy(false);
  }, [mode]);

  const showFieldError = (message: string) => {
    setFieldError(message);
    setFormError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return showFieldError("Inserisci un nome.");
    if (charCount(trimmed) > FOLDER_NAME_MAX)
      return showFieldError(`Il nome può avere al massimo ${FOLDER_NAME_MAX} caratteri.`);
    setBusy(true);
    setFieldError(null);
    setFormError(null);
    try {
      const folder = await onSubmit(trimmed);
      done.current = folder;
      onDone(folder);
    } catch (err) {
      const error = toAppError(err);
      setBusy(false);
      if (error.field === "name" || error.code === "duplicate" || error.code === "validation")
        showFieldError(error.message);
      else setFormError(error);
    }
  };

  const title = mode?.kind === "rename" ? "Rinomina cartella" : "Nuova cartella";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      labelledBy="folder-dialog-title"
      initialFocusRef={inputRef}
      dismissDisabled={busy}
      finalFocus={() => {
        const folder = done.current;
        done.current = null;
        return folder ? focusAfterDone(folder) : null;
      }}
    >
      <form className="dialog-body" onSubmit={submit} noValidate aria-busy={busy}>
        <h2 id="folder-dialog-title" className="dialog-title">
          {title}
        </h2>
        {mode?.kind === "create" && mode.parentName ? <p className="dialog-text">Dentro «{mode.parentName}».</p> : null}
        {formError ? <ErrorBanner error={formError} /> : null}
        <div className="field">
          <label htmlFor="folder-name">Nome</label>
          <input
            ref={inputRef}
            id="folder-name"
            type="text"
            autoComplete="off"
            required
            aria-required="true"
            value={name}
            aria-invalid={fieldError ? true : undefined}
            aria-describedby={fieldError ? "folder-name-error" : undefined}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldError) setFieldError(null);
            }}
          />
          {fieldError ? (
            <p id="folder-name-error" className="field-error">
              {fieldError}
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Annulla
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : null}
            {mode?.kind === "rename" ? "Rinomina" : "Crea cartella"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
