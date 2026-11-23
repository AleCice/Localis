import type { TextStatus } from "../../api/types";
import { Spinner } from "../../components/Spinner";
import { STATUS_EXPLANATION, STATUS_LABEL, type MediaStatus } from "./labels";

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

const MEDIA_TONE: Record<MediaStatus["state"], TextStatus> = {
  untranscribed: "not_applicable",
  queued: "pending",
  running: "pending",
  done: "extracted",
  no_speech: "no_text",
  failed: "failed",
};

const MEDIA_EXPLANATION: Record<MediaStatus["state"], string> = {
  untranscribed: "La registrazione non è ancora stata trascritta: aprila e scegli «Trascrivi».",
  queued: "La trascrizione partirà appena il computer è libero.",
  running: "Localis sta trascrivendo la registrazione su questo computer.",
  done: "Trascrizione automatica: è inclusa nella ricerca e può contenere errori.",
  no_speech: "La trascrizione non ha trovato parlato nella registrazione.",
  failed: "La trascrizione non è riuscita. La registrazione resta ascoltabile.",
};

interface TranscriptionStatusProps {
  status: MediaStatus;
  title: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/** Honest transcription state of an audio/video document. */
export function TranscriptionStatus({ status, title, onRetry, retrying = false }: TranscriptionStatusProps) {
  return (
    <span
      className="status"
      data-status={MEDIA_TONE[status.state]}
      title={status.error ? `${MEDIA_EXPLANATION[status.state]} ${status.error}` : MEDIA_EXPLANATION[status.state]}
    >
      {status.state === "queued" || status.state === "running" ? <Spinner /> : null}
      <span className="status-text">{status.label}</span>
      {status.state === "failed" && onRetry ? (
        <button
          type="button"
          className="link-btn"
          onClick={onRetry}
          disabled={retrying}
          aria-label={`Riprova la trascrizione di «${title}»`}
        >
          Riprova
        </button>
      ) : null}
    </span>
  );
}
