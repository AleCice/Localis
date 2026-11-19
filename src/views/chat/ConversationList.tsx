import { forwardRef } from "react";
import type { Conversation } from "../../api/types";
import { CloseIcon, PlusIcon, TrashIcon } from "../../components/Icons";
import { formatDate } from "../../lib/format";

interface ConversationListProps {
  conversations: Conversation[];
  selectedId: string | null;
  loading: boolean;
  overlay: boolean;
  creating: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (conversation: Conversation) => void;
  onClose: () => void;
}

export const CONVERSATIONS_ID = "chat-conversations";
export const conversationItemId = (id: string) => `conversation-${id}`;

export const ConversationList = forwardRef<HTMLElement, ConversationListProps>(function ConversationList(
  { conversations, selectedId, loading, overlay, creating, onSelect, onCreate, onDelete, onClose },
  ref,
) {
  return (
    <nav
      id={CONVERSATIONS_ID}
      ref={ref}
      className={overlay ? "conversations is-overlay" : "conversations"}
      aria-label="Conversazioni"
      tabIndex={-1}
    >
      <div className="conversations-head">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCreate} disabled={creating}>
          <PlusIcon />
          Nuova conversazione
        </button>
        {overlay ? (
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Chiudi elenco conversazioni" title="Chiudi" onClick={onClose}>
            <CloseIcon />
          </button>
        ) : null}
      </div>
      {conversations.length === 0 ? (
        loading ? null : <p className="hint conversations-empty">Nessuna conversazione.</p>
      ) : (
        <ul className="conversation-list">
          {conversations.map((c) => (
            <li key={c.id} className="conversation-row" aria-current={c.id === selectedId ? "true" : undefined}>
              <button
                type="button"
                id={conversationItemId(c.id)}
                className="conversation-open"
                aria-current={c.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(c.id)}
              >
                <span className="conversation-title">{c.title}</span>
                <span className="conversation-date">
                  <time dateTime={c.updatedAt}>{formatDate(c.updatedAt)}</time>
                </span>
              </button>
              <button
                type="button"
                className="icon-btn icon-btn-sm conversation-delete"
                aria-label={`Elimina la conversazione «${c.title}»`}
                title="Elimina"
                onClick={() => onDelete(c)}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
});
