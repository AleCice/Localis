import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { ChatEvent, ChatMessage, Conversation, Project, SendMessageInput } from "../../api/types";
import {
  LLM_SETTINGS,
  makeConversation,
  makeDocument,
  makeMessage,
  makePreview,
  makeProject,
  makeProvider,
  makeSource,
} from "../../test/fixtures";
import { ChatView } from "./ChatView";

vi.mock("../../api/client", () => ({
  api: {
    getLlmSettings: vi.fn(),
    setLlmSettings: vi.fn(),
    getLlmStatus: vi.fn(),
    listConversations: vi.fn(),
    createConversation: vi.fn(),
    deleteConversation: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    cancelGeneration: vi.fn(),
    listDocuments: vi.fn(),
    prepareCloudSend: vi.fn(),
    discardCloudSend: vi.fn(),
    getKeyringStatus: vi.fn(),
    listProviders: vi.fn(),
    listPrices: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const project = makeProject("Analisi 1");
const doc = makeDocument("Dispensa.pdf");
const notes = makeDocument("Appunti.md", { kind: "markdown" });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function renderChat(conversations: Conversation[] = [], messages: ChatMessage[] = [], forProject: Project = project) {
  mockedApi.listConversations.mockResolvedValue(conversations);
  mockedApi.listMessages.mockResolvedValue(messages);
  const props = {
    onGoToProjects: vi.fn(),
    onConversationChange: vi.fn(),
    onOpenSource: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  const user = userEvent.setup();
  render(
    <ChatView
      project={forProject}
      projectsStatus="ready"
      sidebarToggle={null}
      conversationId={null}
      {...props}
    />,
  );
  return { user, ...props };
}

const composer = () => screen.getByRole("textbox", { name: "Domanda" });
const SETTINGS = { ...LLM_SETTINGS, chatModel: { provider: "lmstudio" as const, model: "qwen" } };

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.getLlmSettings.mockResolvedValue(SETTINGS);
  mockedApi.prepareCloudSend.mockResolvedValue(null);
  mockedApi.discardCloudSend.mockResolvedValue();
  mockedApi.getKeyringStatus.mockResolvedValue({ available: true, message: null, detail: null });
  mockedApi.listProviders.mockResolvedValue([makeProvider("openai", { hasKey: true }), makeProvider("anthropic")]);
  mockedApi.listPrices.mockResolvedValue([]);
  mockedApi.getLlmStatus.mockResolvedValue({
    reachable: true,
    message: null,
    detail: null,
    models: [
      { id: "qwen", kind: "llm", state: "loaded" },
      { id: "llama", kind: "llm", state: "not-loaded" },
      { id: "nomic-embed", kind: "embedding", state: "loaded" },
    ],
  });
  mockedApi.listDocuments.mockResolvedValue([doc, notes]);
  mockedApi.cancelGeneration.mockResolvedValue();
  mockedApi.createConversation.mockImplementation(async () => makeConversation("Nuova conversazione"));
});

describe("chat flow", () => {
  it("streams an answer: accepted → phase → deltas → done, without keeping «Elaborazione…»", async () => {
    const conversation = makeConversation("Zeri");
    const generating = deferred();
    const finishing = deferred();
    let sentInput: SendMessageInput | null = null;
    mockedApi.sendMessage.mockImplementation(async (input, onEvent: (e: ChatEvent) => void) => {
      sentInput = input;
      const userMessage = makeMessage(conversation, "user", input.text);
      onEvent({ type: "accepted", userMessage, assistantMessageId: "answer-1" });
      onEvent({ type: "phase", phase: "retrieving" });
      await generating.promise;
      onEvent({ type: "phase", phase: "generating" });
      onEvent({ type: "delta", text: "Il teorema " });
      onEvent({ type: "delta", text: "garantisce uno zero [1]." });
      await finishing.promise;
      const final = makeMessage(conversation, "assistant", "Il teorema garantisce uno zero [1].", {
        id: "answer-1",
        sources: [makeSource(doc, { unit: 3 })],
      });
      onEvent({ type: "done", message: final });
      return final;
    });
    const { user } = renderChat([conversation]);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalledWith(conversation.id));

    await user.type(composer(), "Cosa dice il teorema degli zeri?{Enter}");
    expect(sentInput).toEqual({ conversationId: conversation.id, text: "Cosa dice il teorema degli zeri?" });
    expect(composer()).toHaveValue("");
    expect(await screen.findByText("Elaborazione…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Interrompi" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Invia" })).not.toBeInTheDocument();

    generating.resolve();
    expect(await screen.findByText(/Il teorema garantisce uno zero/)).toBeInTheDocument();
    expect(screen.queryByText("Elaborazione…")).not.toBeInTheDocument();
    // While streaming, citations are not active yet.
    expect(screen.queryByRole("button", { name: /^Fonte 1/ })).not.toBeInTheDocument();

    finishing.resolve();
    expect(await screen.findByRole("button", { name: "Fonte 1: «Dispensa.pdf», p. 3" })).toBeInTheDocument();
    expect(screen.queryByText("Elaborazione…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invia" })).toBeInTheDocument();
    expect(screen.getByText("Risposta completata.")).toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Messaggi" });
    expect(log).toHaveAttribute("aria-live", "off");
    expect(within(log).getAllByRole("article")).toHaveLength(2);
  });

  it("creates a conversation for the first question", async () => {
    mockedApi.sendMessage.mockImplementation(async (input) =>
      makeMessage(makeConversation("x", { id: input.conversationId }), "assistant", "Risposta."),
    );
    const { user, onConversationChange } = renderChat([]);
    expect(await screen.findByText(/Fai una domanda sui documenti di «Analisi 1»/)).toBeInTheDocument();
    await user.type(composer(), "Domanda{Enter}");
    await waitFor(() => expect(mockedApi.createConversation).toHaveBeenCalledWith(project.id));
    const created = (await mockedApi.createConversation.mock.results[0]!.value) as Conversation;
    await waitFor(() => expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({ conversationId: created.id, text: "Domanda" }));
    expect(onConversationChange).toHaveBeenCalledWith(created.id);
  });

  it("Shift+Enter adds a newline and does not send; empty questions are not sent", async () => {
    const { user } = renderChat([makeConversation("Vuota")]);
    await user.type(composer(), "riga uno{Shift>}{Enter}{/Shift}riga due");
    expect(composer()).toHaveValue("riga uno\nriga due");
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
    await user.clear(composer());
    await user.type(composer(), "   {Enter}");
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Invia" })).toBeDisabled();
  });

  it("«Interrompi» calls cancelGeneration and keeps the partial text with «Risposta interrotta.»", async () => {
    const conversation = makeConversation("Lunga");
    const stopped = deferred();
    mockedApi.cancelGeneration.mockImplementation(async () => stopped.resolve());
    mockedApi.sendMessage.mockImplementation(async (input, onEvent: (e: ChatEvent) => void) => {
      onEvent({ type: "accepted", userMessage: makeMessage(conversation, "user", input.text), assistantMessageId: "a" });
      onEvent({ type: "delta", text: "Testo parziale" });
      await stopped.promise;
      const final = makeMessage(conversation, "assistant", "Testo parziale", {
        id: "a",
        status: "cancelled",
        error: { code: "cancelled", message: "Risposta interrotta." },
      });
      onEvent({ type: "error", error: final.error!, message: final });
      return final;
    });
    const { user } = renderChat([conversation]);
    await user.type(composer(), "Spiega tutto{Enter}");
    expect(await screen.findByText("Testo parziale")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Interrompi" }));
    expect(mockedApi.cancelGeneration).toHaveBeenCalledWith(conversation.id);
    expect(await screen.findByText("Risposta interrotta.", { selector: ".msg-note" })).toBeInTheDocument();
    expect(screen.getByText("Testo parziale")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invia" })).toBeInTheDocument();
  });

  it("llm_unavailable explains what to do and links to Impostazioni", async () => {
    const conversation = makeConversation("Offline");
    const question = makeMessage(conversation, "user", "Domanda");
    const failed = makeMessage(conversation, "assistant", "", {
      status: "error",
      error: { code: "llm_unavailable", message: "LM Studio non è raggiungibile.", detail: "connection refused" },
    });
    const { user, onOpenSettings } = renderChat([conversation], [question, failed]);
    expect(await screen.findByText("LM Studio non è raggiungibile.")).toBeInTheDocument();
    expect(screen.getByText(/Avvia LM Studio e il suo server locale/)).toBeInTheDocument();
    expect(screen.queryByText("connection refused")).not.toBeVisible();
    await user.click(screen.getByRole("button", { name: "Apri Impostazioni" }));
    expect(onOpenSettings).toHaveBeenCalled();

    mockedApi.sendMessage.mockResolvedValue(makeMessage(conversation, "assistant", "Ok."));
    await user.click(screen.getByRole("button", { name: "Riprova" }));
    expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({ conversationId: conversation.id, text: "Domanda" });
  });

  it("shows an error and restores the question when it could not be stored", async () => {
    const conversation = makeConversation("Errore");
    mockedApi.sendMessage.mockRejectedValue({ code: "conflict", message: "È già in corso una risposta." });
    const { user } = renderChat([conversation]);
    await user.type(composer(), "Domanda persa?{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("È già in corso una risposta.");
    expect(composer()).toHaveValue("Domanda persa?");
  });

  it("clarification candidates resend the original question limited to the chosen document", async () => {
    const conversation = makeConversation("Ambigua");
    const question = makeMessage(conversation, "user", "Riassumi la dispensa");
    const clarification = makeMessage(conversation, "assistant", "A quale documento ti riferisci?", {
      kind: "clarification",
      retrieval: null,
      candidates: [
        { documentId: doc.id, title: "Dispensa.pdf" },
        { documentId: notes.id, title: "Appunti.md" },
      ],
    });
    mockedApi.sendMessage.mockResolvedValue(makeMessage(conversation, "assistant", "Ok."));
    const { user } = renderChat([conversation], [question, clarification]);
    await user.click(await screen.findByRole("button", { name: "Appunti.md" }));
    expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({
      conversationId: conversation.id,
      text: "Riassumi la dispensa",
      documentIds: [notes.id],
    });
  });

  it("renders inventory and no_evidence answers distinctly, without sources", async () => {
    const conversation = makeConversation("Elenco");
    const inventory = makeMessage(conversation, "assistant", "Il progetto contiene 2 documenti:\n\n- **Dispensa.pdf**", {
      kind: "inventory",
      retrieval: null,
      model: null,
    });
    const nothing = makeMessage(conversation, "assistant", "Non ho trovato nei documenti di questo progetto passaggi pertinenti.", {
      kind: "no_evidence",
      model: null,
    });
    renderChat([conversation], [inventory, nothing]);
    const list = await screen.findByRole("article", { name: "Elenco dei documenti" });
    expect(within(list).getByText("Elenco dei documenti del progetto, generato da Localis")).toBeInTheDocument();
    expect(within(list).getByText("Dispensa.pdf", { selector: "strong" })).toBeInTheDocument();
    const none = screen.getByText(/Non ho trovato nei documenti/).closest(".msg")!;
    expect(none).toHaveClass("msg-no_evidence");
    expect(screen.queryByText(/Fonti citate/)).not.toBeInTheDocument();
  });
});

describe("sources", () => {
  const conversation = makeConversation("Fonti");
  const answer = makeMessage(conversation, "assistant", "Vero [1] e [2].", {
    sources: [
      makeSource(doc, { rank: 1, n: 1, cited: true, unit: 3 }),
      makeSource(notes, { rank: 2, n: 2, cited: true, unit: 4, available: false }),
      makeSource(doc, { rank: 3, n: 3, cited: false, unit: 7, text: "Passaggio consultato ma non citato." }),
      makeSource(doc, { rank: 4, n: null, cited: false, unit: 9, text: "Risultato grezzo." }),
    ],
  });

  it("are collapsed by default and separate cited from consulted", async () => {
    const { user } = renderChat([conversation], [answer]);
    const cited = (await screen.findByText("Fonti citate (2)")).closest("details")!;
    const consulted = screen.getByText("Fonti consultate (1)").closest("details")!;
    expect(cited).not.toHaveAttribute("open");
    expect(consulted).not.toHaveAttribute("open");
    // Raw results (n = null) only appear in the inspector.
    expect(screen.queryByText("Risultato grezzo.")).not.toBeInTheDocument();

    await user.click(screen.getByText("Fonti citate (2)"));
    expect(within(cited).getByText("Dispensa.pdf")).toBeVisible();
    expect(within(cited).getByText("Documento non più disponibile")).toBeVisible();
    expect(within(cited).getAllByRole("button")).toHaveLength(1);
    await user.click(screen.getByText("Fonti consultate (1)"));
    expect(within(consulted).getByText("Passaggio consultato ma non citato.")).toBeVisible();
  });

  it("citation and source clicks open the cited document version at that unit", async () => {
    const { user, onOpenSource } = renderChat([conversation], [answer]);
    await user.click(await screen.findByRole("button", { name: "Fonte 1: «Dispensa.pdf», p. 3" }));
    expect(onOpenSource).toHaveBeenLastCalledWith({
      documentId: doc.id,
      versionId: doc.current.id,
      unit: 3,
      unitKind: "page",
      snippet: answer.sources[0]!.text,
    });

    // An unavailable source says so instead of navigating.
    await user.click(screen.getByRole("button", { name: /^Fonte 2: «Appunti\.md», blocco 4 \(documento non più disponibile\)/ }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Il documento non è più disponibile.")).toBeInTheDocument();
  });
});

describe("inspector", () => {
  it("is closed by default (not in the DOM) and shows mode, scope, model, query and three tiers", async () => {
    const conversation = makeConversation("Ispeziona");
    const answer = makeMessage(conversation, "assistant", "Vero [1].", {
      model: "qwen",
      retrieval: {
        mode: "hybrid",
        scope: "documents",
        documentIds: [doc.id],
        scopeReason: "title",
        embeddingModel: "nomic-embed",
        embeddingProvider: "lmstudio",
        query: '"teorema"* OR "zeri"',
      },
      sources: [
        makeSource(doc, { rank: 1, n: 1, cited: true, via: "both" }),
        makeSource(doc, { rank: 2, n: 2, cited: false, unit: 5 }),
        makeSource(doc, { rank: 3, n: null, cited: false, unit: 8, via: "semantic" }),
      ],
    });
    const { user } = renderChat([conversation], [answer]);
    await screen.findByRole("button", { name: /^Fonte 1/ });
    expect(screen.queryByRole("complementary", { name: "Dettagli della risposta" })).not.toBeInTheDocument();
    expect(document.getElementById("chat-inspector")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Mostra dettagli della risposta" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const inspector = screen.getByRole("complementary", { name: "Dettagli della risposta" });
    expect(inspector).toHaveFocus();
    expect(within(inspector).getByText(/Ibrida/)).toBeInTheDocument();
    expect(within(inspector).getByText(/nomic-embed/)).toBeInTheDocument();
    expect(within(inspector).getByText("Motivo: documento nominato nella domanda")).toBeInTheDocument();
    expect(within(inspector).getByText("qwen")).toBeInTheDocument();
    expect(within(inspector).getByText('"teorema"* OR "zeri"')).toBeInTheDocument();
    expect(within(within(inspector).getByRole("region", { name: "Risultati grezzi" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(within(inspector).getByRole("region", { name: "Evidenze nel prompt" })).getAllByRole("listitem")).toHaveLength(2);
    expect(within(within(inspector).getByRole("region", { name: "Citate" })).getAllByRole("listitem")).toHaveLength(1);

    await user.click(within(inspector).getByRole("button", { name: "Chiudi dettagli" }));
    expect(document.getElementById("chat-inspector")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Mostra dettagli della risposta" })).toHaveFocus());
  });
});

describe("scope and model", () => {
  it("«Limita a documenti…» picks documents shown as chips and sent as documentIds", async () => {
    const conversation = makeConversation("Scope");
    mockedApi.sendMessage.mockResolvedValue(makeMessage(conversation, "assistant", "Ok."));
    const { user } = renderChat([conversation]);
    await user.click(await screen.findByRole("button", { name: "Limita a documenti…" }));
    const dialog = await screen.findByRole("dialog", { name: "Limita a documenti" });
    await user.type(within(dialog).getByRole("searchbox", { name: "Filtra documenti" }), "appu");
    expect(within(dialog).queryByRole("checkbox", { name: /Dispensa/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("checkbox", { name: /Appunti\.md/ }));
    await user.click(within(dialog).getByRole("button", { name: "Applica (1)" }));

    expect(screen.getByRole("button", { name: "Rimuovi «Appunti.md» dalla selezione" })).toBeInTheDocument();
    await user.type(composer(), "Domanda{Enter}");
    expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({
      conversationId: conversation.id,
      text: "Domanda",
      documentIds: [notes.id],
    });

    await user.click(screen.getByRole("button", { name: "Rimuovi «Appunti.md» dalla selezione" }));
    expect(screen.getByText("Ricerca in tutto il progetto")).toBeInTheDocument();
  });

  it("the header lists only chat models reported by LM Studio and saves the choice", async () => {
    mockedApi.setLlmSettings.mockImplementation(async (s) => s);
    const { user } = renderChat([]);
    const select = await screen.findByRole("combobox", { name: "Modello di chat" });
    const local = within(select).getByRole("group", { name: "Locale (LM Studio)" });
    await waitFor(() =>
      expect(within(local).getAllByRole("option").map((o) => o.textContent)).toEqual(["qwen", "llama (non caricato)"]),
    );
    await user.selectOptions(select, "lmstudio:llama");
    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({
      ...SETTINGS,
      routing: "manual",
      chatModel: { provider: "lmstudio", model: "llama" },
    });
  });

  it("when LM Studio is unreachable says so in the list and «Riprova» rechecks (no fake models)", async () => {
    mockedApi.getLlmStatus.mockResolvedValue({ reachable: false, message: "LM Studio non risponde.", detail: null, models: [] });
    const { user } = renderChat([]);
    const select = await screen.findByRole("combobox", { name: "Modello di chat" });
    const local = within(select).getByRole("group", { name: "Locale (LM Studio)" });
    await waitFor(() =>
      expect(within(local).getAllByRole("option").map((o) => o.textContent)).toEqual(["qwen (LM Studio non raggiungibile)"]),
    );
    await user.click(screen.getByRole("button", { name: "Riprova a contattare LM Studio" }));
    await waitFor(() => expect(mockedApi.getLlmStatus).toHaveBeenCalledTimes(2));
  });
});

describe("conversations", () => {
  it("deletes a conversation after confirmation and selects the next one", async () => {
    const first = makeConversation("Prima");
    const second = makeConversation("Seconda");
    mockedApi.deleteConversation.mockResolvedValue();
    const { user, onConversationChange } = renderChat([first, second]);
    await waitFor(() => expect(onConversationChange).toHaveBeenCalledWith(first.id));

    // The test window is narrow: the list opens over the conversation.
    await user.click(screen.getByRole("button", { name: "Mostra conversazioni" }));
    await user.click(screen.getByRole("button", { name: "Elimina la conversazione «Prima»" }));
    const dialog = screen.getByRole("alertdialog", { name: "Eliminare la conversazione «Prima»?" });
    expect(within(dialog).getByRole("button", { name: "Annulla" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Elimina" }));
    expect(mockedApi.deleteConversation).toHaveBeenCalledWith(first.id);
    await waitFor(() => expect(onConversationChange).toHaveBeenLastCalledWith(second.id));
    expect(screen.queryByText("Prima")).not.toBeInTheDocument();
  });
});

describe("position sources", () => {
  it("labels passages taken from the start of the document honestly", async () => {
    const conversation = makeConversation("Riassunto");
    const answer = makeMessage(conversation, "assistant", "Riassunto [1].", {
      sources: [makeSource(notes, { via: "position", unit: 1 })],
    });
    const { user } = renderChat([conversation], [answer]);
    await user.click(await screen.findByText("Fonti citate (1)"));
    expect(screen.getByText(/Passaggio iniziale: inizio del documento \(nessun termine da cercare\)/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Mostra dettagli della risposta" }));
    const inspector = screen.getByRole("complementary", { name: "Dettagli della risposta" });
    expect(within(inspector).getAllByText(/inizio del documento \(nessun termine da cercare\)/).length).toBeGreaterThan(0);
  });
});

describe("cloud send (v0.4)", () => {
  const cloudProject = makeProject("Tesi", { cloudPolicy: "cloud_allowed" });
  const CLOUD_SETTINGS = { ...LLM_SETTINGS, chatModel: { provider: "openai" as const, model: "gpt-test" } };

  function cloudAnswer(conversation: Conversation, input: SendMessageInput) {
    return makeMessage(conversation, "assistant", "Risposta dal cloud [1].", {
      model: "gpt-test",
      provider: "openai",
      routeReason: "Scelto da te nelle impostazioni.",
      usage: { inputTokens: 3050, outputTokens: 120 },
      cost: { amount: 0.0089, currency: "USD" },
      sources: [makeSource(doc, { unit: 3 })],
      content: `Risposta dal cloud [1]. (${input.text})`,
    });
  }

  beforeEach(() => {
    mockedApi.getLlmSettings.mockResolvedValue(CLOUD_SETTINGS);
  });

  it("a local route sends directly, without any dialog", async () => {
    mockedApi.getLlmSettings.mockResolvedValue(SETTINGS);
    const conversation = makeConversation("Locale");
    mockedApi.sendMessage.mockResolvedValue(makeMessage(conversation, "assistant", "Ok."));
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda locale{Enter}");
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledTimes(1));
    expect(mockedApi.prepareCloudSend).toHaveBeenCalledWith({ conversationId: conversation.id, text: "Domanda locale" });
    expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({ conversationId: conversation.id, text: "Domanda locale" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows every detail of the payload; «Annulla» has the focus, discards the token and sends nothing", async () => {
    const conversation = makeConversation("Cloud");
    mockedApi.prepareCloudSend.mockResolvedValue(makePreview());
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Cosa dice il teorema degli zeri?{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    const cancel = within(dialog).getByRole("button", { name: "Annulla" });
    expect(cancel).toHaveFocus();
    expect(within(dialog).getByText(/api\.openai\.com/)).toBeInTheDocument();
    expect(within(dialog).getByText("gpt-test")).toBeInTheDocument();
    expect(within(dialog).getByText("Scelto da te nelle impostazioni.")).toBeInTheDocument();
    expect(within(dialog).getByText("Cosa dice il teorema degli zeri?", { selector: "blockquote" })).toBeInTheDocument();
    const sent = within(dialog).getByRole("list", { name: "Passaggi inviati" });
    expect(within(sent).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "[1] Dispensa.pdf, p. 3 · 812 caratteri",
      "[2] Appunti.md, blocco 4 · 400 caratteri",
    ]);
    expect(within(dialog).getByText(/1 scambio precedente della conversazione \(230 caratteri\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/12\.345 caratteri · circa 3\.?087 token in ingresso \(stima\) · al massimo 2\.?048 token in uscita/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^da 0,0077\s?(USD|US\$|\$) a 0,0282\s?(USD|US\$|\$) \(stima\)$/)).toBeInTheDocument();
    expect(within(dialog).getByText(/I file originali restano su questo computer/)).toBeInTheDocument();
    expect(within(dialog).queryByText("Già inviato")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Invia a OpenAI" })).toBeInTheDocument();
    // Nothing was sent while the dialog is open.
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByText(/In attesa della tua conferma/)).toBeInTheDocument();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mockedApi.discardCloudSend).toHaveBeenCalledWith("token-1");
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("Cosa dice il teorema degli zeri?");
    expect(screen.getByText("Invio annullato: nulla è stato inviato a OpenAI.")).toBeInTheDocument();
  });

  it("Esc cancels like «Annulla»", async () => {
    const conversation = makeConversation("Esc");
    mockedApi.prepareCloudSend.mockResolvedValue(makePreview());
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda{Enter}");
    await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(mockedApi.discardCloudSend).toHaveBeenCalledWith("token-1"));
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
  });

  it("confirming sends with the token; usage and cost appear under the answer; the next question asks again", async () => {
    const conversation = makeConversation("Conferma");
    let n = 0;
    mockedApi.prepareCloudSend.mockImplementation(async (input) => makePreview({ token: `token-${++n}`, question: input.text }));
    mockedApi.sendMessage.mockImplementation(async (input) => cloudAnswer(conversation, input));
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());

    await user.type(composer(), "Prima domanda{Enter}");
    let dialog = await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    await user.click(within(dialog).getByRole("button", { name: "Invia a OpenAI" }));
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledTimes(1));
    expect(mockedApi.sendMessage.mock.calls[0]![0]).toEqual({
      conversationId: conversation.id,
      text: "Prima domanda",
      confirmToken: "token-1",
    });
    const answer = await screen.findByText(/Risposta dal cloud/, { selector: ".markdown p, p" });
    const article = answer.closest("article")!;
    expect(within(article).getByText(/^OpenAI · gpt-test · 3\.?050 token in ingresso, 120 in uscita · 0,0089/)).toBeInTheDocument();

    await user.type(composer(), "Seconda domanda{Enter}");
    dialog = await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    expect(within(dialog).getByText("Seconda domanda", { selector: "blockquote" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Invia a OpenAI" }));
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledTimes(2));
    expect(mockedApi.prepareCloudSend).toHaveBeenCalledTimes(2);
    expect(mockedApi.sendMessage.mock.calls[1]![0]).toMatchObject({ text: "Seconda domanda", confirmToken: "token-2" });
  });

  it("without a price the cost is «non stimabile»; a query embedding already sent is declared", async () => {
    const conversation = makeConversation("Prezzo");
    mockedApi.prepareCloudSend.mockResolvedValue(
      makePreview({ estCost: null, historyPairs: 0, queryEmbeddedBy: { provider: "openai", model: "embed-test" } }),
    );
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    expect(within(dialog).getByText("Costo non stimabile: imposta il prezzo in Impostazioni")).toBeInTheDocument();
    expect(within(dialog).getByText(/la domanda è stata inviata a OpenAI · embed-test/)).toBeInTheDocument();
    expect(within(dialog).getByText("Nessuno scambio precedente della conversazione.")).toBeInTheDocument();
  });

  it("an expired confirmation (consent_required) prepares again and asks again", async () => {
    const conversation = makeConversation("Scaduta");
    let n = 0;
    mockedApi.prepareCloudSend.mockImplementation(async () => makePreview({ token: `token-${++n}` }));
    mockedApi.sendMessage
      .mockRejectedValueOnce({ code: "consent_required", message: "Conferma non più valida." })
      .mockImplementation(async (input) => cloudAnswer(conversation, input));
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda{Enter}");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Invia a OpenAI" }));

    const again = await screen.findByRole("dialog", { name: "Inviare la domanda a OpenAI?" });
    expect(within(again).getByText(/La conferma precedente non è più valida/)).toBeInTheDocument();
    expect(within(again).getByRole("button", { name: "Annulla" })).toHaveFocus();
    expect(mockedApi.prepareCloudSend).toHaveBeenCalledTimes(2);
    await user.click(within(again).getByRole("button", { name: "Invia a OpenAI" }));
    await waitFor(() => expect(mockedApi.sendMessage).toHaveBeenCalledTimes(2));
    expect(mockedApi.sendMessage.mock.calls[1]![0]).toMatchObject({ confirmToken: "token-2" });
  });

  it("consent_required for a local-only project explains what to do and sends nothing", async () => {
    const conversation = makeConversation("Solo locale");
    mockedApi.prepareCloudSend.mockRejectedValue({
      code: "consent_required",
      message: "Questo progetto è impostato su «Solo locale»: nessun dato può essere inviato a un provider cloud.",
    });
    const { user, onGoToProjects } = renderChat([conversation]);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("«Solo locale»");
    expect(alert).toHaveTextContent(/Nulla è stato inviato/);
    expect(mockedApi.sendMessage).not.toHaveBeenCalled();
    expect(composer()).toHaveValue("Domanda");
    await user.click(within(alert).getByRole("button", { name: "Progetti → Uso del cloud" }));
    expect(onGoToProjects).toHaveBeenCalled();
  });

  it("keyring_unavailable gives plain guidance", async () => {
    const conversation = makeConversation("Portachiavi");
    mockedApi.prepareCloudSend.mockResolvedValue(makePreview());
    mockedApi.sendMessage.mockRejectedValue({ code: "keyring_unavailable", message: "Il portachiavi di sistema non è disponibile." });
    const { user } = renderChat([conversation], [], cloudProject);
    await waitFor(() => expect(mockedApi.listMessages).toHaveBeenCalled());
    await user.type(composer(), "Domanda{Enter}");
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Invia a OpenAI" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Il portachiavi di sistema non è disponibile.");
    expect(alert).toHaveTextContent(/Secret Service/);
  });

  it("the picker groups models; cloud entries are disabled with the reason; the active cloud route is stated", async () => {
    mockedApi.listPrices.mockResolvedValue([
      { provider: "openai", model: "gpt-test", inputPerMTok: 2.5, outputPerMTok: 10, currency: "USD" },
      { provider: "anthropic", model: "claude-test", inputPerMTok: 3, outputPerMTok: 15, currency: "USD" },
    ]);
    // Local-only project: every cloud entry is disabled.
    renderChat([], [], project);
    const select = await screen.findByRole("combobox", { name: "Modello di chat" });
    const cloudGroup = within(select).getByRole("group", { name: "Cloud" });
    await waitFor(() => expect(within(cloudGroup).getAllByRole("option")).toHaveLength(2));
    for (const option of within(cloudGroup).getAllByRole("option")) {
      expect(option).toBeDisabled();
      expect(option.textContent).toMatch(/— progetto solo locale$/);
    }
    expect(screen.getByText("Cloud non consentito in questo progetto")).toBeInTheDocument();
  });

  it("in a project that allows the cloud, only providers without a key are disabled", async () => {
    mockedApi.listPrices.mockResolvedValue([
      { provider: "openai", model: "gpt-test", inputPerMTok: 2.5, outputPerMTok: 10, currency: "USD" },
      { provider: "anthropic", model: "claude-test", inputPerMTok: 3, outputPerMTok: 15, currency: "USD" },
    ]);
    renderChat([], [], cloudProject);
    const select = await screen.findByRole("combobox", { name: "Modello di chat" });
    const cloudGroup = within(select).getByRole("group", { name: "Cloud" });
    const openai = await within(cloudGroup).findByRole("option", { name: "OpenAI · gpt-test" });
    expect(openai).toBeEnabled();
    expect(within(cloudGroup).getByRole("option", { name: "Anthropic · claude-test — nessuna chiave" })).toBeDisabled();
    expect(screen.getByText("Cloud: OpenAI · gpt-test")).toBeInTheDocument();
  });

  it("offers «Automatico» when routing is automatic", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({
      ...LLM_SETTINGS,
      routing: "auto",
      autoModels: [{ provider: "lmstudio", model: "qwen" }, { provider: "openai", model: "gpt-test" }],
    });
    renderChat([], [], cloudProject);
    const select = await screen.findByRole("combobox", { name: "Modello di chat" });
    await waitFor(() => expect(select).toHaveValue("auto"));
    expect(within(select).getByRole("option", { name: "Automatico" })).toBeInTheDocument();
  });

  it("the inspector shows the routing decision and the embedding provider", async () => {
    const conversation = makeConversation("Ispeziona cloud");
    const answer = makeMessage(conversation, "assistant", "Vero [1].", {
      model: "gpt-test",
      provider: "openai",
      routeReason: "Scelto automaticamente: LM Studio non è raggiungibile; il modello cloud più economico.",
      usage: { inputTokens: 900, outputTokens: 50 },
      cost: { amount: 0.0021, currency: "EUR" },
      retrieval: {
        mode: "hybrid",
        scope: "project",
        documentIds: [],
        scopeReason: null,
        embeddingModel: "embed-test",
        embeddingProvider: "openai",
        query: '"zeri"*',
      },
      sources: [makeSource(doc)],
    });
    const { user } = renderChat([conversation], [answer], cloudProject);
    await screen.findByRole("button", { name: /^Fonte 1/ });
    await user.click(screen.getByRole("button", { name: "Mostra dettagli della risposta" }));
    const inspector = screen.getByRole("complementary", { name: "Dettagli della risposta" });
    expect(within(inspector).getByText(/Scelto automaticamente: LM Studio non è raggiungibile/)).toBeInTheDocument();
    expect(within(inspector).getByText(/OpenAI · embed-test/)).toBeInTheDocument();
    expect(within(inspector).getByText("gpt-test")).toBeInTheDocument();
    expect(within(inspector).getByText(/900 token in ingresso, 50 in uscita · 0,0021/)).toBeInTheDocument();
  });
});

describe("sources from recordings (v0.5)", () => {
  it("shows the segment timestamp instead of page/block and opens the media at startMs", async () => {
    const lecture = makeDocument("lezione.mp3", { kind: "audio" });
    const conversation = makeConversation("Lezione");
    const answer = makeMessage(conversation, "assistant", "Il docente lo spiega [1].", {
      sources: [
        makeSource(lecture, {
          rank: 1,
          n: 1,
          cited: true,
          unit: 42,
          unitKind: "segment",
          startMs: 754_000,
          text: "Il teorema degli zeri vale per funzioni continue.",
        }),
      ],
    });
    const { user, onOpenSource } = renderChat([conversation], [answer]);
    const cite = await screen.findByRole("button", { name: "Fonte 1: «lezione.mp3», 00:12:34" });
    await user.click(screen.getByText("Fonti citate (1)"));
    expect(screen.getByText("00:12:34", { selector: ".source-unit" })).toBeVisible();
    await user.click(cite);
    expect(onOpenSource).toHaveBeenLastCalledWith({
      documentId: lecture.id,
      versionId: lecture.current.id,
      unit: 42,
      unitKind: "segment",
      startMs: 754_000,
      snippet: "Il teorema degli zeri vale per funzioni continue.",
    });
  });
});
