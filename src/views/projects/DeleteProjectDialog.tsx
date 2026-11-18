import { useRef, useState } from "react";
import type { AppError, Project } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";

interface DeleteProjectDialogProps {
  project: Project | null;
  onCancel: () => void;
  /** Performs the deletion; rejects with an AppError to keep the dialog open. */
  onConfirm: (project: Project) => Promise<void>;
  /** Element to focus after a confirmed deletion (Cancel returns focus to the trigger). */
  focusAfterDelete: () => HTMLElement | null;
}

export function DeleteProjectDialog({ project, onCancel, onConfirm, focusAfterDelete }: DeleteProjectDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleted = useRef(false);
  // Keep the name visible while the dialog is open even if the prop changes underneath.
  const shown = useRef<Project | null>(null);
  if (project) shown.current = project;
  const target = shown.current;

  const cancel = () => {
    setError(null);
    onCancel();
  };

  const confirm = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError(null);
    // Set before awaiting: the parent may close the dialog as part of onConfirm.
    deleted.current = true;
    try {
      await onConfirm(target);
    } catch (err) {
      deleted.current = false;
      setError(err as AppError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={project !== null}
      onClose={cancel}
      role="alertdialog"
      labelledBy="delete-project-title"
      describedBy="delete-project-desc"
      initialFocusRef={cancelRef}
      dismissDisabled={busy}
      finalFocus={() => {
        if (!deleted.current) return null;
        deleted.current = false;
        return focusAfterDelete();
      }}
    >
      {target ? (
        <div className="dialog-body">
          <h2 id="delete-project-title" className="dialog-title">
            Eliminare «{target.name}»?
          </h2>
          <p id="delete-project-desc" className="dialog-text">
            Il progetto verrà rimosso da Localis. I file sul disco non vengono eliminati.
          </p>
          {error ? <ErrorBanner error={error} /> : null}
          <div className="dialog-actions">
            <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={cancel} disabled={busy}>
              Annulla
            </button>
            <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy} aria-busy={busy}>
              {busy ? <Spinner /> : null}
              Elimina
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
