import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { CloudRequest, EmbeddingStatus, LlmSettings, ProviderInfo } from "../../api/types";
import { EMBEDDING_POLL_MS } from "../../hooks/useEmbeddingStatus";
import { LLM_SETTINGS, makeProject, makeProvider } from "../../test/fixtures";
import { SettingsView } from "../SettingsView";

vi.mock("../../api/client", () => ({
  api: {
    getLlmSettings: vi.fn(),
    setLlmSettings: vi.fn(),
    getLlmStatus: vi.fn(),
    getEmbeddingStatus: vi.fn(),
    getKeyringStatus: vi.fn(),
    listProviders: vi.fn(),
    setApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    listProviderModels: vi.fn(),
    listPrices: vi.fn(),
    setPrice: vi.fn(),
    deletePrice: vi.fn(),
    listCloudRequests: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const project = makeProject("Analisi 1");
const SETTINGS: LlmSettings = { ...LLM_SETTINGS, chatModel: { provider: "lmstudio", model: "qwen" } };

function embedding(state: EmbeddingStatus["state"], embedded = 0, total = 10): EmbeddingStatus {
  return {
    state,
    provider: state === "disabled" ? null : "lmstudio",
    model: state === "disabled" ? null : "nomic-embed",
    total,
    embedded,
    message: null,
  };
}

let providers: ProviderInfo[];

function renderSettings() {
  const user = userEvent.setup();
  render(<SettingsView theme="system" onThemeChange={vi.fn()} sidebarToggle={null} project={project} />);
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  providers = [makeProvider("openai"), makeProvider("anthropic")];
  mockedApi.getLlmSettings.mockResolvedValue(SETTINGS);
  mockedApi.setLlmSettings.mockImplementation(async (s) => s);
  mockedApi.getLlmStatus.mockResolvedValue({
    reachable: true,
    message: null,
    detail: null,
    models: [
      { id: "qwen", kind: "llm", state: "loaded" },
      { id: "nomic-embed", kind: "embedding", state: "not-loaded" },
    ],
  });
  mockedApi.getEmbeddingStatus.mockResolvedValue(embedding("disabled"));
  mockedApi.getKeyringStatus.mockResolvedValue({ available: true, message: null, detail: null });
  mockedApi.listProviders.mockImplementation(async () => providers);
  mockedApi.setApiKey.mockImplementation(async (id) => {
    providers = providers.map((p) => (p.id === id ? { ...p, hasKey: true } : p));
    return providers.find((p) => p.id === id)!;
  });
  mockedApi.deleteApiKey.mockImplementation(async (id) => {
    providers = providers.map((p) => (p.id === id ? { ...p, hasKey: false } : p));
    return providers.find((p) => p.id === id)!;
  });
  mockedApi.listPrices.mockResolvedValue([]);
  mockedApi.setPrice.mockImplementation(async (price) => [price]);
  mockedApi.listCloudRequests.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

const providerSection = (name: string) => screen.getByRole("region", { name });

describe("Modelli locali (LM Studio)", () => {
  it("shows the backend's URL validation error at the field and focuses it", async () => {
    mockedApi.setLlmSettings.mockRejectedValue({
      code: "validation",
      field: "baseUrl",
      message: "Sono ammessi solo indirizzi http di questo computer.",
    });
    const user = renderSettings();
    const url = await screen.findByRole("textbox", { name: "Indirizzo del server di LM Studio" });
    await waitFor(() => expect(url).toHaveValue("http://127.0.0.1:1234"));
    await user.clear(url);
    await user.type(url, "http://example.com:1234");
    const lmSection = screen.getByRole("region", { name: "Modelli locali (LM Studio)" });
    await user.click(within(lmSection).getByRole("button", { name: "Salva" }));

    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({ ...SETTINGS, baseUrl: "http://example.com:1234" });
    expect(await screen.findByText("Sono ammessi solo indirizzi http di questo computer.")).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url).toHaveAccessibleDescription("Sono ammessi solo indirizzi http di questo computer.");
    await waitFor(() => expect(url).toHaveFocus());
  });

  it("shows connection status, groups the models and saves the choices as model references", async () => {
    const user = renderSettings();
    expect(await screen.findByText(/Connesso a LM Studio · 2 modelli/)).toBeInTheDocument();
    expect(screen.getByText(/restano su questo computer/)).toBeInTheDocument();

    const chat = screen.getByRole("combobox", { name: "Modello di chat" });
    expect(within(within(chat).getByRole("group", { name: "Locale (LM Studio)" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "qwen",
    ]);
    const emb = screen.getByRole("combobox", { name: "Modello di embedding" });
    expect(within(emb).getByRole("option", { name: "Nessuno — solo ricerca lessicale" })).toBeInTheDocument();
    expect(
      within(within(emb).getByRole("group", { name: "Locale (LM Studio)" })).getAllByRole("option").map((o) => o.textContent),
    ).toEqual(["nomic-embed (non caricato)"]);
    expect(within(emb).getByRole("group", { name: "Cloud" })).toBeInTheDocument();
    expect(screen.getByText(/serve il consenso di ciascun progetto/)).toBeInTheDocument();
    await user.selectOptions(emb, "lmstudio:nomic-embed");
    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({
      ...SETTINGS,
      embeddingModel: { provider: "lmstudio", model: "nomic-embed" },
    });
    expect(await screen.findByText("Modello di embedding salvato.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verifica connessione" }));
    await waitFor(() => expect(mockedApi.getLlmStatus).toHaveBeenCalledTimes(2));
  });

  it("says when LM Studio is unreachable, without inventing local models", async () => {
    mockedApi.getLlmStatus.mockResolvedValue({
      reachable: false,
      message: "LM Studio non risponde su http://127.0.0.1:1234.",
      detail: "connection refused",
      models: [],
    });
    mockedApi.getLlmSettings.mockResolvedValue({ ...SETTINGS, chatModel: null });
    renderSettings();
    expect(await screen.findByText("LM Studio non risponde su http://127.0.0.1:1234.")).toBeInTheDocument();
    expect(screen.getByText(/Avvia LM Studio e il suo server locale/)).toBeInTheDocument();
    const chat = screen.getByRole("combobox", { name: "Modello di chat" });
    const local = within(within(chat).getByRole("group", { name: "Locale (LM Studio)" })).getAllByRole("option");
    expect(local.map((o) => o.textContent)).toEqual(["LM Studio non raggiungibile"]);
    expect(local[0]).toBeDisabled();
  });

  it("polls the embedding status only while indexing is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedApi.getLlmSettings.mockResolvedValue({ ...SETTINGS, embeddingModel: { provider: "lmstudio", model: "nomic-embed" } });
    mockedApi.getEmbeddingStatus
      .mockResolvedValueOnce(embedding("running", 3))
      .mockResolvedValueOnce(embedding("running", 7))
      .mockResolvedValue(embedding("idle", 10));
    renderSettings();

    expect(await screen.findByText(/Passaggi indicizzati: 3 di 10/)).toBeInTheDocument();
    expect(screen.getByText("In corso")).toBeInTheDocument();
    const calls = () => mockedApi.getEmbeddingStatus.mock.calls.length;
    const afterFirst = calls();

    await act(() => vi.advanceTimersByTimeAsync(EMBEDDING_POLL_MS));
    expect(await screen.findByText(/Passaggi indicizzati: 7 di 10/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(EMBEDDING_POLL_MS));
    expect(await screen.findByText(/Passaggi indicizzati: 10 di 10/)).toBeInTheDocument();
    expect(screen.getByText("Completata")).toBeInTheDocument();
    const settled = calls();
    expect(settled).toBe(afterFirst + 2);

    await act(() => vi.advanceTimersByTimeAsync(EMBEDDING_POLL_MS * 3));
    expect(calls()).toBe(settled);
    expect(mockedApi.getEmbeddingStatus).toHaveBeenCalledWith(project.id);
  });

  it("does not poll when no embedding model is configured", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderSettings();
    expect(await screen.findByText("Non attiva: nessun modello di embedding")).toBeInTheDocument();
    const before = mockedApi.getEmbeddingStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(EMBEDDING_POLL_MS * 3));
    expect(mockedApi.getEmbeddingStatus.mock.calls.length).toBe(before);
  });

  it("explains a cloud embedding model waiting for the project's consent", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({ ...SETTINGS, embeddingModel: { provider: "openai", model: "embed-test" } });
    mockedApi.getEmbeddingStatus.mockResolvedValue({
      state: "needs_consent",
      provider: "openai",
      model: "embed-test",
      total: 10,
      embedded: 0,
      message: null,
    });
    renderSettings();
    expect(await screen.findByText(/In attesa di consenso/)).toBeInTheDocument();
    expect(screen.getByText(/«Analisi 1» è un progetto «Solo locale»: i suoi passaggi non vengono inviati a OpenAI/)).toBeInTheDocument();
  });
});

describe("Provider cloud", () => {
  it("saves a key to the keychain, clears the field and never renders the key", async () => {
    const user = renderSettings();
    const openai = await waitFor(() => providerSection("OpenAI"));
    expect(within(openai).getByText(/api\.openai\.com/)).toBeInTheDocument();
    expect(screen.getByText(/salvate nel portachiavi di sistema, mai nel database/)).toBeInTheDocument();
    const field = within(openai).getByLabelText("Chiave API di OpenAI");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    await user.type(field, "sk-test-SEGRETA-123");
    await user.click(within(openai).getByRole("button", { name: "Salva" }));

    await waitFor(() => expect(mockedApi.setApiKey).toHaveBeenCalledWith("openai", "sk-test-SEGRETA-123"));
    expect(await within(openai).findByText("Chiave salvata nel portachiavi")).toBeInTheDocument();
    expect(within(openai).queryByLabelText("Chiave API di OpenAI")).not.toBeInTheDocument();
    expect(screen.getByText("Chiave di OpenAI salvata nel portachiavi.")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("SEGRETA");
    for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain("SEGRETA");

    // Replacing: the new field starts empty.
    await user.click(within(openai).getByRole("button", { name: "Sostituisci chiave" }));
    expect(within(openai).getByLabelText("Nuova chiave API di OpenAI")).toHaveValue("");
  });

  it("removes a key only after confirmation (focus on «Annulla»)", async () => {
    providers = [makeProvider("openai", { hasKey: true })];
    const user = renderSettings();
    const openai = await waitFor(() => providerSection("OpenAI"));
    await user.click(within(openai).getByRole("button", { name: "Rimuovi chiave" }));
    const dialog = screen.getByRole("alertdialog", { name: "Rimuovere la chiave di OpenAI?" });
    expect(within(dialog).getByRole("button", { name: "Annulla" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.deleteApiKey).not.toHaveBeenCalled();

    await user.click(within(openai).getByRole("button", { name: "Rimuovi chiave" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Rimuovi chiave" }));
    await waitFor(() => expect(mockedApi.deleteApiKey).toHaveBeenCalledWith("openai"));
    expect(await within(openai).findByLabelText("Chiave API di OpenAI")).toBeInTheDocument();
  });

  it("explains a missing keychain and disables key entry", async () => {
    mockedApi.getKeyringStatus.mockResolvedValue({
      available: false,
      message: "Il portachiavi di sistema non è disponibile.",
      detail: "no Secret Service",
    });
    renderSettings();
    expect(await screen.findByText("Il portachiavi di sistema non è disponibile.")).toBeInTheDocument();
    expect(screen.getByText(/non esiste un'alternativa in chiaro/)).toBeInTheDocument();
    expect(within(providerSection("OpenAI")).getByLabelText("Chiave API di OpenAI")).toBeDisabled();
  });

  it("loads models on request (stating the provider is contacted) and offers them for chat", async () => {
    providers = [makeProvider("openai", { hasKey: true }), makeProvider("anthropic")];
    mockedApi.listProviderModels.mockResolvedValue({
      provider: "openai",
      reachable: true,
      message: null,
      detail: null,
      models: [
        { id: "gpt-test", kind: "unknown", state: null },
        { id: "embed-test", kind: "embedding", state: null },
      ],
    });
    const user = renderSettings();
    const openai = await waitFor(() => providerSection("OpenAI"));
    expect(within(openai).getByText("Contatta api.openai.com con la tua chiave per ottenere l'elenco dei modelli.")).toBeInTheDocument();
    expect(mockedApi.listProviderModels).not.toHaveBeenCalled();
    expect(within(providerSection("Anthropic")).getByRole("button", { name: "Carica modelli" })).toBeDisabled();

    await user.click(within(openai).getByRole("button", { name: "Carica modelli" }));
    expect(mockedApi.listProviderModels).toHaveBeenCalledWith("openai");
    expect(await within(openai).findByText("gpt-test")).toBeInTheDocument();
    expect(within(openai).getByText("2 modelli")).toBeInTheDocument();

    const chat = screen.getByRole("combobox", { name: "Modello di chat" });
    const cloud = within(chat).getByRole("group", { name: "Cloud" });
    expect(within(cloud).getAllByRole("option").map((o) => o.textContent)).toEqual(["OpenAI · gpt-test"]);
    const emb = screen.getByRole("combobox", { name: "Modello di embedding" });
    expect(within(within(emb).getByRole("group", { name: "Cloud" })).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "OpenAI · gpt-test",
      "OpenAI · embed-test",
    ]);
    await user.selectOptions(chat, "openai:gpt-test");
    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({ ...SETTINGS, chatModel: { provider: "openai", model: "gpt-test" } });
  });

  it("shows a provider error when the model list cannot be read", async () => {
    providers = [makeProvider("openai", { hasKey: true })];
    mockedApi.listProviderModels.mockResolvedValue({
      provider: "openai",
      reachable: false,
      message: "Chiave API non valida o senza permessi per OpenAI.",
      detail: "HTTP 401",
      models: [],
    });
    const user = renderSettings();
    const openai = await waitFor(() => providerSection("OpenAI"));
    await user.click(within(openai).getByRole("button", { name: "Carica modelli" }));
    expect(await within(openai).findByText("Chiave API non valida o senza permessi per OpenAI.")).toBeInTheDocument();
  });
});

describe("Prezzi", () => {
  it("validates the form at the fields and saves parsed prices", async () => {
    const user = renderSettings();
    const section = await screen.findByRole("region", { name: "Prezzi" });
    expect(within(section).getByText(/Localis non conosce i prezzi: inseriscili dal listino del provider/)).toBeInTheDocument();
    expect(within(section).getByText("Nessun prezzo inserito.")).toBeInTheDocument();

    await user.click(within(section).getByRole("button", { name: "Salva prezzo" }));
    const model = within(section).getByRole("textbox", { name: "Modello" });
    expect(model).toHaveAttribute("aria-invalid", "true");
    expect(model).toHaveFocus();
    expect(mockedApi.setPrice).not.toHaveBeenCalled();

    await user.type(model, "gpt-test");
    const input = within(section).getByRole("textbox", { name: "Input per milione di token" });
    await user.type(input, "due");
    await user.type(within(section).getByRole("textbox", { name: "Output per milione di token" }), "10");
    await user.click(within(section).getByRole("button", { name: "Salva prezzo" }));
    expect(input).toHaveFocus();
    expect(input).toHaveAccessibleDescription("Inserisci un numero non negativo, ad esempio 2,50.");
    expect(mockedApi.setPrice).not.toHaveBeenCalled();

    await user.clear(input);
    await user.type(input, "2,50");
    await user.click(within(section).getByRole("button", { name: "Salva prezzo" }));
    await waitFor(() =>
      expect(mockedApi.setPrice).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-test",
        inputPerMTok: 2.5,
        outputPerMTok: 10,
        currency: "USD",
      }),
    );
    const table = await within(section).findByRole("table", { name: "Prezzi per milione di token" });
    expect(within(table).getByText("gpt-test")).toBeInTheDocument();
    expect(within(table).getByText("2,5 USD")).toBeInTheDocument();
  });
});

describe("Instradamento", () => {
  it("reorders candidates with the keyboard and keeps the focus on the moved one", async () => {
    mockedApi.getLlmSettings.mockResolvedValue({
      ...SETTINGS,
      routing: "auto",
      autoModels: [
        { provider: "lmstudio", model: "qwen" },
        { provider: "openai", model: "gpt-test" },
      ],
    });
    const user = renderSettings();
    expect(await screen.findByText(/il primo modello locale disponibile/)).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Candidati, in ordine di preferenza" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("LM Studio · qwen"),
      expect.stringContaining("OpenAI · gpt-test"),
    ]);
    expect(within(list).getByRole("button", { name: "Sposta su LM Studio · qwen" })).toBeDisabled();

    within(list).getByRole("button", { name: "Sposta giù LM Studio · qwen" }).focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(mockedApi.setLlmSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          autoModels: [
            { provider: "openai", model: "gpt-test" },
            { provider: "lmstudio", model: "qwen" },
          ],
        }),
      ),
    );
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
        expect.stringContaining("OpenAI · gpt-test"),
        expect.stringContaining("LM Studio · qwen"),
      ]),
    );
    // The moved item reached the bottom: focus stays on it («Sposta su»).
    await waitFor(() => expect(within(list).getByRole("button", { name: "Sposta su LM Studio · qwen" })).toHaveFocus());
    expect(screen.getByText("Ordine dei candidati salvato.")).toBeInTheDocument();
  });

  it("switches between manual and automatic routing", async () => {
    const user = renderSettings();
    await user.click(await screen.findByRole("radio", { name: "Automatico" }));
    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({ ...SETTINGS, routing: "auto" });
    expect(await screen.findByText("Nessun candidato: aggiungi almeno un modello.")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Modello da aggiungere ai candidati" }), "lmstudio:qwen");
    await user.click(screen.getByRole("button", { name: "Aggiungi" }));
    expect(mockedApi.setLlmSettings).toHaveBeenLastCalledWith({
      ...SETTINGS,
      routing: "auto",
      autoModels: [{ provider: "lmstudio", model: "qwen" }],
    });
  });
});

describe("Attività cloud", () => {
  it("shows an empty state", async () => {
    renderSettings();
    expect(await screen.findByText("Nessuna richiesta inviata ai provider cloud.")).toBeInTheDocument();
  });

  it("lists requests with provider, model, purpose, characters, tokens, cost and outcome", async () => {
    const items: CloudRequest[] = [
      {
        id: 2,
        createdAt: "2026-03-10T10:00:00.000Z",
        provider: "openai",
        model: "gpt-test",
        purpose: "chat",
        projectId: project.id,
        conversationId: null,
        charsSent: 12345,
        usage: { inputTokens: 3050, outputTokens: 120 },
        cost: { amount: 0.0089, currency: "USD" },
        ok: true,
        error: null,
      },
      {
        id: 1,
        createdAt: "2026-03-10T09:00:00.000Z",
        provider: "anthropic",
        model: null,
        purpose: "list_models",
        projectId: null,
        conversationId: null,
        charsSent: 0,
        usage: null,
        cost: null,
        ok: false,
        error: "Chiave API non valida.",
      },
    ];
    mockedApi.listCloudRequests.mockResolvedValue(items);
    renderSettings();
    const table = await screen.findByRole("table", { name: "Richieste ai provider cloud, dalla più recente" });
    expect(mockedApi.listCloudRequests).toHaveBeenCalledWith(100);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    const first = within(rows[0]!).getAllByRole("cell").map((c) => c.textContent);
    expect(first.slice(1)).toEqual(["OpenAI", "gpt-test", "Domanda in chat", "12.345", "3050 / 120", expect.stringMatching(/^0,0089/), "Riuscita"]);
    const second = within(rows[1]!).getAllByRole("cell").map((c) => c.textContent);
    expect(second.slice(1)).toEqual(["Anthropic", "—", "Elenco modelli", "0", "—", "—", "Non riuscita: Chiave API non valida."]);
  });
});
