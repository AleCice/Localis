import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { EmbeddingStatus } from "../../api/types";
import { makeProject } from "../../test/fixtures";
import { EMBEDDING_POLL_MS, LlmSettingsSection } from "./LlmSettingsSection";

vi.mock("../../api/client", () => ({
  api: {
    getLlmSettings: vi.fn(),
    setLlmSettings: vi.fn(),
    getLlmStatus: vi.fn(),
    getEmbeddingStatus: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const project = makeProject("Analisi 1");
const SETTINGS = { baseUrl: "http://127.0.0.1:1234", chatModel: "qwen", embeddingModel: null };

function embedding(state: EmbeddingStatus["state"], embedded = 0, total = 10): EmbeddingStatus {
  return { state, model: state === "disabled" ? null : "nomic-embed", total, embedded, message: null };
}

beforeEach(() => {
  vi.resetAllMocks();
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
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Modelli locali (LM Studio)", () => {
  it("shows the backend's URL validation error at the field and focuses it", async () => {
    mockedApi.setLlmSettings.mockRejectedValue({
      code: "validation",
      field: "baseUrl",
      message: "Sono ammessi solo indirizzi http di questo computer.",
    });
    const user = userEvent.setup();
    render(<LlmSettingsSection project={project} />);
    const url = await screen.findByRole("textbox", { name: "Indirizzo del server di LM Studio" });
    await waitFor(() => expect(url).toHaveValue("http://127.0.0.1:1234"));
    await user.clear(url);
    await user.type(url, "http://example.com:1234");
    await user.click(screen.getByRole("button", { name: "Salva" }));

    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({ ...SETTINGS, baseUrl: "http://example.com:1234" });
    expect(await screen.findByText("Sono ammessi solo indirizzi http di questo computer.")).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url).toHaveAccessibleDescription("Sono ammessi solo indirizzi http di questo computer.");
    await waitFor(() => expect(url).toHaveFocus());
  });

  it("shows connection status, privacy note and saves the chosen models", async () => {
    const user = userEvent.setup();
    render(<LlmSettingsSection project={project} />);
    expect(await screen.findByText(/Connesso a LM Studio · 2 modelli/)).toBeInTheDocument();
    expect(screen.getByText(/restano su questo computer/)).toBeInTheDocument();

    const chat = screen.getByRole("combobox", { name: "Modello di chat" });
    expect(within(chat).getAllByRole("option").map((o) => o.textContent)).toEqual(["qwen"]);
    const emb = screen.getByRole("combobox", { name: "Modello di embedding" });
    expect(within(emb).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Nessuno — solo ricerca lessicale",
      "nomic-embed (non caricato)",
    ]);
    await user.selectOptions(emb, "nomic-embed");
    expect(mockedApi.setLlmSettings).toHaveBeenCalledWith({ ...SETTINGS, embeddingModel: "nomic-embed" });
    expect(await screen.findByText("Modello di embedding salvato.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verifica connessione" }));
    await waitFor(() => expect(mockedApi.getLlmStatus).toHaveBeenCalledTimes(2));
  });

  it("disables the model selects and explains what to do when LM Studio is unreachable", async () => {
    mockedApi.getLlmStatus.mockResolvedValue({
      reachable: false,
      message: "LM Studio non risponde su http://127.0.0.1:1234.",
      detail: "connection refused",
      models: [],
    });
    render(<LlmSettingsSection project={project} />);
    expect(await screen.findByText("LM Studio non risponde su http://127.0.0.1:1234.")).toBeInTheDocument();
    expect(screen.getByText(/Avvia LM Studio e il suo server locale/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Modello di chat" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Modello di embedding" })).toBeDisabled();
  });

  it("polls the embedding status only while indexing is running", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedApi.getLlmSettings.mockResolvedValue({ ...SETTINGS, embeddingModel: "nomic-embed" });
    mockedApi.getEmbeddingStatus
      .mockResolvedValueOnce(embedding("running", 3))
      .mockResolvedValueOnce(embedding("running", 7))
      .mockResolvedValue(embedding("idle", 10));
    render(<LlmSettingsSection project={project} />);

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
    render(<LlmSettingsSection project={project} />);
    expect(await screen.findByText("Non attiva: nessun modello di embedding")).toBeInTheDocument();
    const before = mockedApi.getEmbeddingStatus.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(EMBEDDING_POLL_MS * 3));
    expect(mockedApi.getEmbeddingStatus.mock.calls.length).toBe(before);
  });
});
