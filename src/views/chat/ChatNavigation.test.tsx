import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { LibraryDocument } from "../../api/types";
import { App } from "../../App";
import { LLM_SETTINGS, makeConversation, makeDocument, makeMessage, makeProject, makeSource, makeProvider } from "../../test/fixtures";

vi.mock("../../api/client", () => ({
  api: {
    listProjects: vi.fn(),
    listFolders: vi.fn(),
    listDocuments: vi.fn(),
    listJobs: vi.fn(),
    listVersions: vi.fn(),
    getText: vi.fn(),
    readOriginal: vi.fn(),
    getLlmSettings: vi.fn(),
    getKeyringStatus: vi.fn(),
    listProviders: vi.fn(),
    listPrices: vi.fn(),
    listCloudRequests: vi.fn(),
    getLlmStatus: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const project = makeProject("Analisi 1");
const conversation = makeConversation("Zeri");

function setup(doc: LibraryDocument, sourceVersionId: string) {
  const answer = makeMessage(conversation, "assistant", "Lo dice il teorema [1].", {
    sources: [makeSource(doc, { versionId: sourceVersionId, unit: 2, text: "Il passaggio citato sugli zeri." })],
  });
  mockedApi.listProjects.mockResolvedValue([project]);
  mockedApi.listDocuments.mockResolvedValue([doc]);
  mockedApi.listConversations.mockResolvedValue([conversation]);
  mockedApi.listMessages.mockResolvedValue([answer]);
  window.localStorage.setItem("localis.onboarded", "true");
  const user = userEvent.setup();
  render(<App />);
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.listFolders.mockResolvedValue([]);
  mockedApi.listJobs.mockResolvedValue([]);
  mockedApi.getLlmSettings.mockResolvedValue(LLM_SETTINGS);
  mockedApi.getKeyringStatus.mockResolvedValue({ available: true, message: null, detail: null });
  mockedApi.listProviders.mockResolvedValue([makeProvider("openai")]);
  mockedApi.listPrices.mockResolvedValue([]);
  mockedApi.listCloudRequests.mockResolvedValue([]);
  mockedApi.getLlmStatus.mockResolvedValue({ reachable: false, message: null, detail: null, models: [] });
  mockedApi.getText.mockResolvedValue([
    { unit: 1, text: "Primo blocco." },
    { unit: 2, text: "Il passaggio citato sugli zeri." },
    { unit: 3, text: "Terzo blocco." },
  ]);
});

describe("citation navigation", () => {
  it("opens the Library on the cited document and block, shows the passage and returns to the chat", async () => {
    const doc = makeDocument("Appunti.md", { kind: "markdown" });
    const user = setup(doc, doc.current.id);
    await user.click(await screen.findByRole("button", { name: "Chat" }));
    await user.click(await screen.findByRole("button", { name: "Fonte 1: «Appunti.md», blocco 2" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Libreria" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Appunti.md" })).toBeInTheDocument();
    const passage = screen.getByRole("complementary", { name: /Passaggio citato · blocco 2/ });
    expect(within(passage).getByText("Il passaggio citato sugli zeri.")).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.getText).toHaveBeenCalledWith(doc.current.id));
    const block = await screen.findByText("Il passaggio citato sugli zeri.", { selector: ".text-block" });
    expect(block).toHaveClass("is-target");
    expect(block).toHaveFocus();

    await user.click(within(passage).getByRole("button", { name: "Torna alla chat" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fonte 1: «Appunti.md», blocco 2" })).toBeInTheDocument();
    // The chat stayed mounted: conversations were not reloaded.
    expect(mockedApi.listConversations).toHaveBeenCalledTimes(1);
  });

  it("opens the version the source came from when it is not the current one", async () => {
    const doc = makeDocument("Appunti.md", { kind: "markdown", versionCount: 2 });
    const old = { ...doc.current, id: "e0000000-0000-4000-8000-0000000000ff", versionNo: 1 };
    mockedApi.listVersions.mockResolvedValue([doc.current, old]);
    const user = setup(doc, old.id);
    await user.click(await screen.findByRole("button", { name: "Chat" }));
    await user.click(await screen.findByRole("button", { name: "Fonte 1: «Appunti.md», blocco 2" }));

    expect(await screen.findByText("Stai vedendo la versione 1 di 2.")).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.getText).toHaveBeenCalledWith(old.id));
    expect(mockedApi.getText).not.toHaveBeenCalledWith(doc.current.id);
    expect(await screen.findByText("Il passaggio citato sugli zeri.", { selector: ".text-block" })).toHaveClass("is-target");
  });
});
