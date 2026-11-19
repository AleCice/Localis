import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import type { AppError, ChatEvent, ChatMessage, Conversation, LibraryDocument, Project, Source } from "../../api/types";
import { toAppError } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ChatIcon, PanelRightIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useLlm } from "../../hooks/useLlm";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { LoadStatus } from "../../hooks/useProjects";
import type { LibraryLink } from "../../lib/navigation";
import { readPref, STORAGE_KEYS, writePref } from "../../lib/storage";
import { Composer, type ComposerHandle } from "./Composer";
import { conversationItemId, ConversationList, CONVERSATIONS_ID } from "./ConversationList";
import { Inspector, INSPECTOR_ID } from "./Inspector";
import { AssistantMessage, Thinking, UserMessage } from "./MessageView";
import { ModelPicker } from "./ModelPicker";
import { ScopeDialog } from "./ScopeDialog";

/** From this width the conversation list is a column; below it opens over the conversation. */
export const CHAT_LIST_INLINE_QUERY = "(min-width: 64rem)";
/** From this width the inspector is a column; below it opens over the conversation. */
// Inline only when the thread keeps a comfortable width next to both side panels.
export const CHAT_INSPECTOR_INLINE_QUERY = "(min-width: 96rem)";
/** Streamed text is rendered at most this often (ms). */
const RENDER_INTERVAL_MS = 40;

interface ChatViewProps {
  project: Project | null;
  projectsStatus: LoadStatus;
  onGoToProjects: () => void;
  sidebarToggle: ReactNode;
  /** Selected conversation, kept by the app while switching views. */
  conversationId: string | null;
  onConversationChange: (id: string | null) => void;
  onOpenSource: (link: Omit<LibraryLink, "nonce">) => void;
  onOpenSettings: () => void;
  /** The view is visible (it stays mounted in the background once opened). */
  active?: boolean;
}

export function ChatView(props: ChatViewProps) {
  const { project, projectsStatus, onGoToProjects, sidebarToggle } = props;
  if (project) return <Chat key={project.id} {...props} project={project} />;
  return (
    <div className="view">
      <div className="view-header">
        {sidebarToggle}
        <h1 className="view-title">Chat</h1>
      </div>
      <div className="view-content">
        {projectsStatus === "ready" || projectsStatus === "error" ? (
          <div className="empty">
            <p>
              {projectsStatus === "ready"
                ? "Le conversazioni appartengono a un progetto. Crea o seleziona un progetto per iniziare."
                : "Non è stato possibile caricare i progetti."}
            </p>
            <button type="button" className="btn btn-primary" onClick={onGoToProjects}>
              Vai a Progetti
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface Generation {
  /** Null while the conversation for a first question is being created. */
  conversationId: string | null;
  text: string;
  documentIds: string[];
  user: ChatMessage | null;
  assistant: ChatMessage | null;
  finished: boolean;
}

/** Appends or replaces messages by id, keeping chronological order. */
function merge(list: ChatMessage[], extra: (ChatMessage | null)[]): ChatMessage[] {
  const next = [...list];
  for (const m of extra) {
    if (!m) continue;
    const at = next.findIndex((x) => x.id === m.id);
    if (at >= 0) next[at] = m;
    else next.push(m);
  }
  return next;
}

function announcementFor(message: ChatMessage): string {
  if (message.status === "cancelled" || message.error?.code === "cancelled") return "Risposta interrotta.";
  if (message.status === "error") return message.error?.message ?? "Non è stato possibile completare la risposta.";
  switch (message.kind) {
    case "inventory":
      return "Elenco dei documenti pronto.";
    case "clarification":
      return `Serve un chiarimento. ${message.content}`;
    case "no_evidence":
      return message.content;
    default:
      return "Risposta completata.";
  }
}

function Chat({
  project,
  sidebarToggle,
  conversationId,
  onConversationChange,
  onOpenSource,
  onOpenSettings,
  active = true,
}: ChatViewProps & { project: Project }) {
  const llm = useLlm();
  const listInline = useMediaQuery(CHAT_LIST_INLINE_QUERY);
  const inspectorInline = useMediaQuery(CHAT_INSPECTOR_INLINE_QUERY);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [convStatus, setConvStatus] = useState<LoadStatus>("loading");
  const [convError, setConvError] = useState<AppError | null>(null);
  const [selectedId, setSelectedIdState] = useState<string | null>(conversationId);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [msgStatus, setMsgStatus] = useState<LoadStatus>("ready");
  const [msgError, setMsgError] = useState<AppError | null>(null);
  const [msgAttempt, setMsgAttempt] = useState(0);

  const [generation, setGeneration] = useState<Generation | null>(null);
  const genRef = useRef<Generation | null>(null);
  const renderTimer = useRef<number | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [turnError, setTurnError] = useState<AppError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<string[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[] | null>(null);
  const [docsError, setDocsError] = useState<AppError | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);

  const [listPref, setListPrefState] = useState(() => readPref(STORAGE_KEYS.chatConversations, ["open", "closed"] as const, "open"));
  const [listOverlayOpen, setListOverlayOpen] = useState(false);
  const listOpen = listInline ? listPref === "open" : listOverlayOpen;
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [creating, setCreating] = useState(false);

  const logRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<ComposerHandle>(null);
  const listToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const focusPanel = useRef<"list" | "inspector" | null>(null);

  const selectConversation = useCallback(
    (id: string | null) => {
      setSelectedIdState(id);
      selectedRef.current = id;
      onConversationChange(id);
      setInspectedId(null);
      setTurnError(null);
      setNotice(null);
      stickToBottom.current = true;
    },
    [onConversationChange],
  );

  // ---- Conversations
  const loadConversations = useCallback(
    async (quiet: boolean) => {
      if (!quiet) {
        setConvStatus("loading");
        setConvError(null);
      }
      try {
        const items = await api.listConversations(project.id);
        setConversations(items);
        setConvStatus("ready");
        return items;
      } catch (err) {
        if (!quiet) {
          setConvError(toAppError(err));
          setConvStatus("error");
        }
        return null;
      }
    },
    [project.id],
  );

  useEffect(() => {
    void loadConversations(false).then((items) => {
      if (!items) return;
      const keep = items.find((c) => c.id === selectedRef.current);
      selectConversation(keep ? keep.id : (items[0]?.id ?? null));
    });
    // Mount only: selection changes afterwards come from the user.
  }, [loadConversations]);

  // ---- Messages of the selected conversation
  useEffect(() => {
    setMessages([]);
    setMsgError(null);
    if (!selectedId) {
      setMsgStatus("ready");
      return;
    }
    let alive = true;
    setMsgStatus("loading");
    api.listMessages(selectedId).then(
      (items) => {
        if (!alive) return;
        setMessages((prev) => merge(items, prev));
        setMsgStatus("ready");
      },
      (err: unknown) => {
        if (!alive) return;
        setMsgError(toAppError(err));
        setMsgStatus("error");
      },
    );
    return () => {
      alive = false;
    };
  }, [selectedId, msgAttempt]);
  const showMsgLoading = useDelayedFlag(msgStatus === "loading");

  // ---- Project documents (scope picker, inspector titles)
  const loadDocuments = useCallback(async () => {
    setDocsError(null);
    try {
      setDocuments(await api.listDocuments(project.id));
    } catch (err) {
      setDocsError(toAppError(err));
    }
  }, [project.id]);
  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // Back from another view: settings (Impostazioni) and documents (Libreria) may have changed.
  const wasActive = useRef(active);
  const { reload: reloadLlm } = llm;
  useEffect(() => {
    if (active && !wasActive.current) {
      reloadLlm();
      void loadDocuments();
    }
    wasActive.current = active;
  }, [active, reloadLlm, loadDocuments]);
  const docById = useMemo(() => new Map((documents ?? []).map((d) => [d.id, d])), [documents]);
  // Selected documents that were deleted meanwhile drop out of the selection.
  useEffect(() => {
    if (documents) setScope((prev) => prev.filter((id) => docById.has(id)));
  }, [documents, docById]);

  // ---- Scrolling: follow the end of the conversation unless the user scrolled up.
  const onLogScroll = () => {
    const el = logRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    const el = logRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  });

  // ---- Panels focus: move focus into a panel when it opens (keyboard users land in it).
  useEffect(() => {
    if (focusPanel.current === "list" && listOpen) listRef.current?.focus();
    if (focusPanel.current === "inspector" && inspectorOpen) inspectorRef.current?.focus();
    focusPanel.current = null;
  }, [listOpen, inspectorOpen]);

  const setListOpen = (open: boolean, returnFocus = false) => {
    if (open) focusPanel.current = "list";
    if (listInline) {
      setListPrefState(open ? "open" : "closed");
      writePref(STORAGE_KEYS.chatConversations, open ? "open" : "closed");
    } else {
      setListOverlayOpen(open);
    }
    if (!open && returnFocus) requestAnimationFrame(() => listToggleRef.current?.focus());
  };
  const closeInspector = (returnFocus = false) => {
    setInspectorOpen(false);
    if (returnFocus) requestAnimationFrame(() => inspectorToggleRef.current?.focus());
  };

  // ---- Sending
  const scheduleRender = () => {
    if (renderTimer.current !== null) return;
    renderTimer.current = window.setTimeout(() => {
      renderTimer.current = null;
      setGeneration(genRef.current ? { ...genRef.current } : null);
    }, RENDER_INTERVAL_MS);
  };
  useEffect(
    () => () => {
      if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
    },
    [],
  );

  const finish = (gen: Generation, final: ChatMessage | null, error: AppError | null) => {
    if (gen.finished) return;
    gen.finished = true;
    if (renderTimer.current !== null) {
      window.clearTimeout(renderTimer.current);
      renderTimer.current = null;
    }
    if (selectedRef.current === gen.conversationId) {
      setMessages((prev) => merge(prev, [gen.user, final]));
      if (!final && error) {
        setTurnError(error);
        if (!gen.user) setDraft((d) => (d.trim() === "" ? gen.text : d));
      }
    }
    genRef.current = null;
    setGeneration(null);
    setCancelling(false);
    setAnnouncement(final ? announcementFor(final) : (error?.message ?? ""));
    void loadConversations(true);
  };

  const send = async (text: string, documentIds: string[]) => {
    const question = text.trim();
    if (!question || genRef.current) return;
    setTurnError(null);
    setNotice(null);
    setAnnouncement("");
    // Show the question and the waiting indicator right away, also while a conversation is created.
    const gen: Generation = {
      conversationId: selectedRef.current,
      text: question,
      documentIds,
      user: null,
      assistant: null,
      finished: false,
    };
    genRef.current = gen;
    setGeneration({ ...gen });
    setDraft("");
    stickToBottom.current = true;

    if (!gen.conversationId) {
      setCreating(true);
      try {
        const created = await api.createConversation(project.id);
        setConversations((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
        gen.conversationId = created.id;
        selectConversation(created.id);
        setGeneration({ ...gen });
      } catch (err) {
        finish(gen, null, toAppError(err));
        return;
      } finally {
        setCreating(false);
      }
    }
    const convId = gen.conversationId!;

    const onEvent = (event: ChatEvent) => {
      if (gen.finished) return;
      switch (event.type) {
        case "accepted":
          gen.user = event.userMessage;
          gen.assistant = {
            id: event.assistantMessageId,
            conversationId: convId,
            role: "assistant",
            kind: "answer",
            content: "",
            status: "streaming",
            error: null,
            model: null,
            createdAt: event.userMessage.createdAt,
            retrieval: null,
            sources: [],
            candidates: [],
          };
          setGeneration({ ...gen });
          break;
        case "phase":
          break;
        case "delta":
          if (gen.assistant) {
            gen.assistant = { ...gen.assistant, content: gen.assistant.content + event.text };
            scheduleRender();
          }
          break;
        case "done":
          finish(gen, event.message, null);
          break;
        case "error":
          finish(gen, event.message, event.error);
          break;
      }
    };

    try {
      const final = await api.sendMessage(
        { conversationId: convId, text: question, ...(documentIds.length > 0 ? { documentIds } : {}) },
        onEvent,
      );
      finish(gen, final, null);
    } catch (err) {
      finish(gen, null, toAppError(err));
    }
  };

  const cancel = async () => {
    const gen = genRef.current;
    if (!gen || !gen.conversationId || cancelling) return;
    setCancelling(true);
    try {
      await api.cancelGeneration(gen.conversationId);
    } catch (err) {
      setCancelling(false);
      setTurnError(toAppError(err));
    }
  };

  // ---- Message actions
  const openSource = useCallback(
    (source: Source) => {
      if (!source.available) {
        setNotice("Il documento non è più disponibile.");
        return;
      }
      onOpenSource({
        documentId: source.documentId,
        versionId: source.versionId,
        unit: source.unit,
        unitKind: source.unitKind,
        snippet: source.text,
      });
    },
    [onOpenSource],
  );

  const questionBefore = (message: ChatMessage): ChatMessage | null => {
    const at = messages.findIndex((m) => m.id === message.id);
    for (let i = at - 1; i >= 0; i--) if (messages[i]!.role === "user") return messages[i]!;
    return null;
  };

  const chooseCandidate = (message: ChatMessage, documentId: string) => {
    const question = questionBefore(message);
    if (question) void send(question.content, [documentId]);
  };

  const retry = (message: ChatMessage) => {
    const question = questionBefore(message);
    if (!question) return;
    const ids = message.retrieval?.scopeReason === "selection" ? message.retrieval.documentIds : scope;
    void send(question.content, ids);
  };

  const inspect = useCallback((message: ChatMessage) => {
    setInspectedId(message.id);
    focusPanel.current = "inspector";
    setInspectorOpen(true);
  }, []);

  const handlers = {
    onOpenSource: openSource,
    onInspect: inspect,
    onChooseCandidate: chooseCandidate,
    onRetry: retry,
    onOpenSettings,
  };

  // ---- Conversation actions
  const createConversation = async () => {
    setCreating(true);
    setTurnError(null);
    try {
      const created = await api.createConversation(project.id);
      setConversations((prev) => [created, ...prev.filter((c) => c.id !== created.id)]);
      selectConversation(created.id);
      if (!listInline) setListOverlayOpen(false);
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (err) {
      setTurnError(toAppError(err));
    } finally {
      setCreating(false);
    }
  };

  const deleteConversation = async () => {
    if (!deleting) return;
    const target = deleting;
    if (genRef.current?.conversationId === target.id) {
      await api.cancelGeneration(target.id).catch(() => undefined);
    }
    try {
      await api.deleteConversation(target.id);
    } catch (err) {
      if (toAppError(err).code !== "not_found") throw err;
    }
    const index = conversations.findIndex((c) => c.id === target.id);
    const rest = conversations.filter((c) => c.id !== target.id);
    setConversations(rest);
    if (selectedRef.current === target.id) {
      const next = rest[Math.min(index, rest.length - 1)] ?? null;
      selectConversation(next?.id ?? null);
    }
    setDeleting(null);
  };

  // ---- Derived view state
  const current = conversations.find((c) => c.id === selectedId) ?? null;
  const ownGeneration = generation && generation.conversationId === selectedId ? generation : null;
  const hiddenIds = new Set([ownGeneration?.user?.id, ownGeneration?.assistant?.id].filter(Boolean) as string[]);
  const shown = messages.filter((m) => !hiddenIds.has(m.id));
  const answers = messages.filter((m) => m.role === "assistant" && m.status !== "streaming");
  const inspected =
    answers.find((m) => m.id === inspectedId) ??
    [...answers].reverse().find((m) => m.retrieval !== null) ??
    answers[answers.length - 1] ??
    null;
  const busy = generation !== null;
  const empty = shown.length === 0 && !ownGeneration && msgStatus === "ready";
  const scopeChips = scope.map((id) => ({ id, title: docById.get(id)?.title ?? "Documento" }));
  const documentTitle = useCallback((id: string) => docById.get(id)?.title ?? null, [docById]);

  const panelKeyDown = (which: "list" | "inspector") => (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (which === "list" && !listInline) {
      event.preventDefault();
      setListOpen(false, true);
    } else if (which === "inspector" && !inspectorInline) {
      event.preventDefault();
      closeInspector(true);
    }
  };

  return (
    <div className="view view-chat">
      <div className="view-header chat-header">
        {sidebarToggle}
        <button
          ref={listToggleRef}
          type="button"
          className="icon-btn"
          aria-expanded={listOpen}
          aria-controls={listOpen ? CONVERSATIONS_ID : undefined}
          aria-label={listOpen ? "Nascondi conversazioni" : "Mostra conversazioni"}
          title={listOpen ? "Nascondi conversazioni" : "Mostra conversazioni"}
          onClick={() => setListOpen(!listOpen)}
        >
          <ChatIcon />
        </button>
        <div className="view-title library-title chat-title">
          <h1>Chat</h1>
          <p className="view-context" title={current ? `${project.name} · ${current.title}` : project.name}>
            {project.name}
            {current ? ` · ${current.title}` : ""}
          </p>
        </div>
        <ModelPicker llm={llm} />
        <button
          ref={inspectorToggleRef}
          type="button"
          className="icon-btn"
          aria-expanded={inspectorOpen}
          aria-controls={inspectorOpen ? INSPECTOR_ID : undefined}
          aria-label={inspectorOpen ? "Nascondi dettagli della risposta" : "Mostra dettagli della risposta"}
          title={inspectorOpen ? "Nascondi dettagli della risposta" : "Mostra dettagli della risposta"}
          onClick={() => {
            if (inspectorOpen) closeInspector();
            else {
              focusPanel.current = "inspector";
              setInspectorOpen(true);
            }
          }}
        >
          <PanelRightIcon />
        </button>
      </div>

      {convStatus === "error" && convError ? (
        <ErrorBanner error={convError} action={{ label: "Riprova", onClick: () => void loadConversations(false) }} />
      ) : null}

      <div className="chat" data-list={listOpen ? (listInline ? "inline" : "overlay") : "closed"} data-inspector={inspectorOpen ? (inspectorInline ? "inline" : "overlay") : "closed"}>
        {listOpen ? (
          <div className="chat-side" onKeyDown={panelKeyDown("list")}>
            <ConversationList
              ref={listRef}
              conversations={conversations}
              selectedId={selectedId}
              loading={convStatus === "loading"}
              overlay={!listInline}
              creating={creating}
              onSelect={(id) => {
                if (id !== selectedRef.current) selectConversation(id);
                if (!listInline) setListOpen(false);
                requestAnimationFrame(() => composerRef.current?.focus());
              }}
              onCreate={() => void createConversation()}
              onDelete={setDeleting}
              onClose={() => setListOpen(false, true)}
            />
          </div>
        ) : null}

        <section className="chat-thread" aria-label="Conversazione">
          <div
            ref={logRef}
            className="chat-log"
            role="log"
            aria-live="off"
            aria-label="Messaggi"
            aria-busy={busy || msgStatus === "loading"}
            onScroll={onLogScroll}
          >
            <div className="chat-log-inner">
              {msgStatus === "loading" && showMsgLoading ? (
                <p className="loading" role="status">
                  <Spinner />
                  Caricamento…
                </p>
              ) : null}
              {msgStatus === "error" && msgError ? (
                <ErrorBanner error={msgError} action={{ label: "Riprova", onClick: () => setMsgAttempt((a) => a + 1) }} />
              ) : null}
              {empty ? (
                <div className="chat-empty">
                  <p>Fai una domanda sui documenti di «{project.name}». Le risposte indicano i passaggi da cui provengono.</p>
                  {llm.status && !llm.status.reachable ? (
                    <p className="hint">
                      LM Studio non è raggiungibile: avvialo insieme al suo server locale per ottenere risposte dal
                      modello. L'elenco dei documenti funziona comunque.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {shown.map((m) =>
                m.role === "user" ? (
                  <UserMessage key={m.id} content={m.content} />
                ) : (
                  <AssistantMessage
                    key={m.id}
                    message={m}
                    inspected={inspectorOpen && inspected?.id === m.id}
                    busy={busy}
                    {...handlers}
                  />
                ),
              )}
              {ownGeneration ? (
                <>
                  <UserMessage content={ownGeneration.user?.content ?? ownGeneration.text} pending={!ownGeneration.user} />
                  {ownGeneration.assistant ? (
                    <AssistantMessage message={ownGeneration.assistant} inspected={false} busy {...handlers} />
                  ) : (
                    <div className="msg msg-assistant" aria-busy="true">
                      <Thinking />
                    </div>
                  )}
                </>
              ) : null}
              {turnError ? <ErrorBanner error={turnError} action={{ label: "Chiudi", onClick: () => setTurnError(null) }} /> : null}
            </div>
          </div>
          {notice ? (
            <div className="chat-notice notice" role="status">
              <span>{notice}</span>
              <button type="button" className="link-btn" onClick={() => setNotice(null)}>
                Chiudi
              </button>
            </div>
          ) : null}
          <Composer
            ref={composerRef}
            value={draft}
            onChange={setDraft}
            onSend={() => void send(draft, scope)}
            generating={busy}
            cancelling={cancelling}
            onCancel={() => void cancel()}
            scope={scopeChips}
            onPickScope={() => {
              setScopeOpen(true);
              void loadDocuments();
            }}
            onRemoveScope={(id) => setScope((prev) => prev.filter((x) => x !== id))}
          />
          <p className="visually-hidden" role="status" aria-live="polite">
            {announcement}
          </p>
        </section>

        {inspectorOpen ? (
          <div className="chat-inspector" onKeyDown={panelKeyDown("inspector")}>
            <Inspector
              ref={inspectorRef}
              message={inspected}
              documentTitle={documentTitle}
              onOpenSource={openSource}
              onClose={() => closeInspector(true)}
              overlay={!inspectorInline}
            />
          </div>
        ) : null}
      </div>

      <ScopeDialog
        open={scopeOpen}
        documents={documents}
        error={docsError}
        selected={scope}
        onClose={() => setScopeOpen(false)}
        onApply={(ids) => {
          setScope(ids);
          setScopeOpen(false);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Eliminare la conversazione «${deleting?.title ?? ""}»?`}
        confirmLabel="Elimina"
        onCancel={() => setDeleting(null)}
        onConfirm={deleteConversation}
        focusAfterConfirm={() =>
          (selectedRef.current ? document.getElementById(conversationItemId(selectedRef.current)) : null) ??
          listToggleRef.current
        }
      >
        <p>Domande, risposte e fonti registrate della conversazione verranno eliminate. I documenti non vengono toccati.</p>
      </ConfirmDialog>
    </div>
  );
}
