import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { WhisperModel } from "../../api/types";
import { MODEL_POLL_MS } from "../../hooks/useWhisperModels";
import { makeWhisperModel } from "../../test/fixtures";
import { TranscriptionSection } from "./TranscriptionSection";

vi.mock("../../api/client", () => ({
  api: {
    listWhisperModels: vi.fn(),
    downloadWhisperModel: vi.fn(),
    cancelWhisperDownload: vi.fn(),
    deleteWhisperModel: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
let models: WhisperModel[];

beforeEach(() => {
  vi.resetAllMocks();
  models = [makeWhisperModel("tiny", { installed: true }), makeWhisperModel("small")];
  mockedApi.listWhisperModels.mockImplementation(async () => models);
});

afterEach(() => {
  vi.useRealTimers();
});

const row = (name: RegExp) => screen.getByText(name, { selector: ".whisper-model-name" }).closest("li")!;

describe("Impostazioni → Trascrizione", () => {
  it("lists models with size and state and states the privacy rules", async () => {
    render(<TranscriptionSection />);
    expect(await screen.findByRole("heading", { name: "Trascrizione" })).toBeInTheDocument();
    expect(await screen.findByText("Whisper Tiny")).toBeInTheDocument();
    expect(within(row(/Whisper Tiny/)).getByText("Installato")).toBeInTheDocument();
    expect(within(row(/Whisper Small/)).getByText("Da scaricare")).toBeInTheDocument();
    expect(within(row(/Whisper Small/)).getByText("ggml-small.bin · 465 MB")).toBeInTheDocument();
    expect(screen.getByText(/avviene su questo computer/)).toHaveTextContent("contatta solo huggingface.co");
    expect(mockedApi.listWhisperModels).toHaveBeenCalledTimes(1);
  });

  it("downloads only after a confirmation naming host and size, polls while it runs, and cancels", async () => {
    const user = userEvent.setup();
    mockedApi.downloadWhisperModel.mockImplementation(async (id) => {
      models = models.map((m) => (m.id === id ? { ...m, download: { receivedBytes: 0, totalBytes: m.sizeBytes } } : m));
      return models;
    });
    mockedApi.cancelWhisperDownload.mockImplementation(async (id) => {
      models = models.map((m) => (m.id === id ? { ...m, download: null } : m));
      return models;
    });
    render(<TranscriptionSection />);
    await user.click(await screen.findByRole("button", { name: "Scarica Whisper Small (465 MB)" }));

    const dialog = screen.getByRole("alertdialog", { name: "Scaricare Whisper Small?" });
    expect(dialog).toHaveTextContent("huggingface.co");
    expect(dialog).toHaveTextContent("465 MB");
    expect(mockedApi.downloadWhisperModel).not.toHaveBeenCalled();
    // «Annulla» has the initial focus: cancelling does not download.
    await user.click(within(dialog).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.downloadWhisperModel).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Scarica Whisper Small (465 MB)" }));
    await user.click(
      within(screen.getByRole("alertdialog", { name: "Scaricare Whisper Small?" })).getByRole("button", {
        name: "Scarica (465 MB)",
      }),
    );
    expect(mockedApi.downloadWhisperModel).toHaveBeenCalledWith("small");
    expect(await screen.findByRole("progressbar", { name: "Scaricamento di Whisper Small" })).toBeInTheDocument();

    // Progress arrives by polling, only while a download runs.
    models = models.map((m) => (m.id === "small" ? { ...m, download: { receivedBytes: m.sizeBytes / 2, totalBytes: m.sizeBytes } } : m));
    expect(await screen.findByText(/Scaricamento 50 %/, {}, { timeout: MODEL_POLL_MS * 3 })).toBeInTheDocument();
    expect(screen.getByText("Whisper Small: scaricamento 50 %.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Annulla lo scaricamento di Whisper Small" }));
    expect(mockedApi.cancelWhisperDownload).toHaveBeenCalledWith("small");
    expect(await within(row(/Whisper Small/)).findByText("Da scaricare")).toBeInTheDocument();
    const calls = mockedApi.listWhisperModels.mock.calls.length;
    await act(() => new Promise((r) => setTimeout(r, MODEL_POLL_MS * 1.5)));
    expect(mockedApi.listWhisperModels.mock.calls.length).toBe(calls);
  });

  it("deletes an installed model after confirmation and shows download errors", async () => {
    const user = userEvent.setup();
    models = [makeWhisperModel("tiny", { installed: true }), makeWhisperModel("base", { error: "Il file scaricato non corrisponde (SHA-256)." })];
    mockedApi.deleteWhisperModel.mockImplementation(async (id) => {
      models = models.map((m) => (m.id === id ? { ...m, installed: false } : m));
      return models;
    });
    render(<TranscriptionSection />);
    expect(await screen.findByText("Il file scaricato non corrisponde (SHA-256).")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Elimina Whisper Tiny" }));
    const dialog = screen.getByRole("alertdialog", { name: "Eliminare Whisper Tiny?" });
    await user.click(within(dialog).getByRole("button", { name: "Elimina" }));
    expect(mockedApi.deleteWhisperModel).toHaveBeenCalledWith("tiny");
    expect(await within(row(/Whisper Tiny/)).findByText("Da scaricare")).toBeInTheDocument();
  });
});
