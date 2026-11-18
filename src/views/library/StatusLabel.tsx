import type { TextStatus } from "../../api/types";
import { Spinner } from "../../components/Spinner";
import { STATUS_EXPLANATION, STATUS_LABEL } from "./labels";

interface StatusLabelProps {
  status: TextStatus;
  /** Shown for `failed` when a retry is possible. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Used to give «Riprova» a unique accessible name in lists. */
  title: string;
}

/** Brief, honest state of the searchable text of a version. */
export function StatusLabel({ status, onRetry, retrying = false, title }: StatusLabelProps) {
  return (
    <span className="status" data-status={status} title={STATUS_EXPLANATION[status]}>
      {status === "pending" ? <Spinner /> : null}
      <span className="status-text">{STATUS_LABEL[status]}</span>
      {status === "failed" && onRetry ? (
        <button
          type="button"
          className="link-btn"
          onClick={onRetry}
          disabled={retrying}
          aria-label={`Riprova l'estrazione di «${title}»`}
        >
          Riprova
        </button>
      ) : null}
    </span>
  );
}
