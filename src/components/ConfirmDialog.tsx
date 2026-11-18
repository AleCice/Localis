import { useId, useRef, useState, type ReactNode } from "react";
import type { AppError } from "../api/types";
import { toAppError } from "../api/types";
import { Dialog } from "./Dialog";
import { ErrorBanner } from "./ErrorBanner";
import { Spinner } from "./Spinner";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onCancel: () => void;
  /** Performs the action; rejecting keeps the dialog open and shows the error. */
  onConfirm: () => Promise<void>;
  /** Focus target after a confirmed action (Cancel returns focus to the opener). */
  focusAfterConfirm?: () => HTMLElement | null;
}

/** Confirmation for a destructive action. Focus starts on «Annulla». */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = true,
  onCancel,
  onConfirm,
  focusAfterConfirm,
}: ConfirmDialogProps) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmed = useRef(false);

  const cancel = () => {
    setError(null);
    onCancel();
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    confirmed.current = true;
    try {
      await onConfirm();
    } catch (err) {
      confirmed.current = false;
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={cancel}
      role="alertdialog"
      labelledBy={`${id}-title`}
      describedBy={`${id}-desc`}
      initialFocusRef={cancelRef}
      dismissDisabled={busy}
      finalFocus={() => {
        if (!confirmed.current) return null;
        confirmed.current = false;
        return focusAfterConfirm?.() ?? null;
      }}
    >
      <div className="dialog-body">
        <h2 id={`${id}-title`} className="dialog-title">
          {title}
        </h2>
        <div id={`${id}-desc`} className="dialog-text">
          {children}
        </div>
        {error ? <ErrorBanner error={error} /> : null}
        <div className="dialog-actions">
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={cancel} disabled={busy}>
            Annulla
          </button>
          <button
            type="button"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            onClick={confirm}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
