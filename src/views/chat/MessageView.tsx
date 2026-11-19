import { memo, useMemo } from "react";
import type { ChatMessage, Source } from "../../api/types";
import { AlertIcon, InfoIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { citationLabel } from "./labels";
import { Markdown, type CitationInfo } from "./Markdown";
import { Sources } from "./Sources";

export interface MessageActions {
  onOpenSource: (source: Source) => void;
  onInspect: (message: ChatMessage) => void;
  onChooseCandidate: (message: ChatMessage, documentId: string) => void;
  onRetry: (message: ChatMessage) => void;
  onOpenSettings: () => void;
}

interface MessageViewProps extends MessageActions {
  message: ChatMessage;
  /** This answer is the one shown in the open inspector. */
  inspected: boolean;
  /** Controls are disabled while another answer is being generated. */
  busy: boolean;
}

/** Placeholder shown while waiting for the first part of the answer. Never stored in the history. */
export function Thinking() {
  return (
    <p className="thinking">
      <Spinner />
      Elaborazione…
    </p>
  );
}

export const UserMessage = memo(function UserMessage({ content, pending }: { content: string; pending?: boolean }) {
  return (
    <article className="msg msg-user" aria-label="La tua domanda" aria-busy={pending || undefined}>
      <p className="msg-text">{content}</p>
    </article>
  );
});

function ErrorPart({ message, onRetry, onOpenSettings, busy }: { message: ChatMessage } & Pick<MessageActions, "onRetry" | "onOpenSettings"> & { busy: boolean }) {
  const error = message.error;
  if (!error) return null;
  if (error.code === "cancelled") return <p className="msg-note">Risposta interrotta.</p>;
  const unavailable = error.code === "llm_unavailable";
  return (
    <div className="msg-error" role="note">
      <AlertIcon />
      <div className="msg-error-body">
        <p>{error.message || (unavailable ? "LM Studio non è raggiungibile." : "Non è stato possibile completare la risposta.")}</p>
        {unavailable ? (
          <p className="hint">Avvia LM Studio e il suo server locale, poi scegli un modello di chat in Impostazioni.</p>
        ) : null}
        {error.detail ? (
          <details className="banner-details">
            <summary>Dettagli</summary>
            <pre>{error.detail}</pre>
          </details>
        ) : null}
        <div className="msg-error-actions">
          {unavailable ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenSettings}>
              Apri Impostazioni
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRetry(message)} disabled={busy}>
            Riprova
          </button>
        </div>
      </div>
    </div>
  );
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  inspected,
  busy,
  onOpenSource,
  onInspect,
  onChooseCandidate,
  onRetry,
  onOpenSettings,
}: MessageViewProps) {
  const citations = useMemo(() => {
    const map = new Map<number, CitationInfo>();
    for (const s of message.sources) {
      if (s.cited && s.n != null) map.set(s.n, { label: citationLabel(s), onOpen: () => onOpenSource(s) });
    }
    return map;
  }, [message.sources, onOpenSource]);

  const streaming = message.status === "streaming";
  const cancelled = message.status === "cancelled" || message.error?.code === "cancelled";
  const hasDetails = message.retrieval !== null || message.kind !== "answer";

  let body;
  if (message.kind === "no_evidence") {
    body = (
      <div className="msg-info">
        <InfoIcon />
        <p className="msg-text">{message.content}</p>
      </div>
    );
  } else if (message.kind === "clarification") {
    body = (
      <div className="msg-clarify">
        <p className="msg-text">{message.content}</p>
        {message.candidates.length > 0 ? (
          <ul className="candidate-list" aria-label="Documenti possibili">
            {message.candidates.map((c) => (
              <li key={c.documentId}>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm candidate"
                  onClick={() => onChooseCandidate(message, c.documentId)}
                  disabled={busy}
                >
                  {c.title}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        {message.kind === "inventory" ? <p className="msg-label">Elenco dei documenti del progetto, generato da Localis</p> : null}
        {message.content ? <Markdown content={message.content} citations={streaming ? undefined : citations} /> : null}
        {streaming && !message.content ? <Thinking /> : null}
      </>
    );
  }

  return (
    <article
      className={`msg msg-assistant msg-${message.kind}`}
      aria-label={message.kind === "inventory" ? "Elenco dei documenti" : "Risposta"}
      aria-busy={streaming || undefined}
      data-inspected={inspected || undefined}
    >
      {body}
      {cancelled ? <p className="msg-note">Risposta interrotta.</p> : <ErrorPart message={message} onRetry={onRetry} onOpenSettings={onOpenSettings} busy={busy} />}
      {!streaming ? (
        <div className="msg-foot">
          <Sources sources={message.sources} onOpen={onOpenSource} />
          {hasDetails ? (
            <button
              type="button"
              className="link-btn msg-inspect"
              aria-label="Dettagli della risposta"
              aria-pressed={inspected}
              onClick={() => onInspect(message)}
            >
              Dettagli
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});
