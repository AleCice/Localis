import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api/client";
import type { AppError, Project } from "./api/types";
import { App } from "./App";
import { LLM_SETTINGS, makeProject, makeProvider } from "./test/fixtures";
import { setSystemDark } from "./test/setup";

vi.mock("./api/client", () => ({
  api: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    deleteProject: vi.fn(),
    listFolders: vi.fn(),
    listDocuments: vi.fn(),
    listJobs: vi.fn(),
    getLlmSettings: vi.fn(),
    getKeyringStatus: vi.fn(),
    listProviders: vi.fn(),
    listPrices: vi.fn(),
    listCloudRequests: vi.fn(),
    getLlmStatus: vi.fn(),
    getEmbeddingStatus: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);

function withProjects(projects: Project[]) {
  mockedApi.listProjects.mockResolvedValue(projects);
}

function renderApp({ onboarded = true }: { onboarded?: boolean } = {}) {
  if (onboarded) window.localStorage.setItem("localis.onboarded", "true");
  const user = userEvent.setup();
  render(<App />);
  return user;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.listDocuments.mockResolvedValue([]);
  mockedApi.listFolders.mockResolvedValue([]);
  mockedApi.listJobs.mockResolvedValue([]);
  mockedApi.getLlmSettings.mockResolvedValue(LLM_SETTINGS);
  mockedApi.getKeyringStatus.mockResolvedValue({ available: true, message: null, detail: null });
  mockedApi.listProviders.mockResolvedValue([makeProvider("openai")]);
  mockedApi.listPrices.mockResolvedValue([]);
  mockedApi.listCloudRequests.mockResolvedValue([]);
  mockedApi.getLlmStatus.mockResolvedValue({ reachable: false, message: "LM Studio non risponde.", detail: null, models: [] });
  mockedApi.getEmbeddingStatus.mockResolvedValue({ state: "disabled", provider: null, model: null, total: 0, embedded: 0, message: null });
  mockedApi.listConversations.mockResolvedValue([]);
  mockedApi.listMessages.mockResolvedValue([]);
});

describe("onboarding", () => {
  it("is shown on first run when there are no projects, and not again after skipping", async () => {
    withProjects([]);
    const user = renderApp({ onboarded: false });

    expect(await screen.findByRole("heading", { name: "Benvenuto in Localis" })).toBeInTheDocument();
    expect(screen.getByText(/un corso, una tesi o una ricerca/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Salta" }));

    expect(screen.queryByRole("heading", { name: "Benvenuto in Localis" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Progetti" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nuovo progetto" })).toBeInTheDocument();
    expect(window.localStorage.getItem("localis.onboarded")).toBe("true");
  });

  it("is not shown when projects already exist", async () => {
    withProjects([makeProject("Analisi 1")]);
    renderApp({ onboarded: false });

    expect(await screen.findByRole("option", { name: "Analisi 1" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Benvenuto in Localis" })).not.toBeInTheDocument();
    await waitFor(() => expect(window.localStorage.getItem("localis.onboarded")).toBe("true"));
  });

  it("«Crea il primo progetto» opens the creation form with focus on Nome", async () => {
    withProjects([]);
    const user = renderApp({ onboarded: false });

    await user.click(await screen.findByRole("button", { name: "Crea il primo progetto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo progetto" });
    expect(within(dialog).getByLabelText("Nome")).toHaveFocus();
  });

  it("survives unavailable localStorage", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    withProjects([]);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Salta" }));
    expect(screen.getByRole("heading", { level: 1, name: "Progetti" })).toBeInTheDocument();
    getItem.mockRestore();
    setItem.mockRestore();
  });
});

describe("projects", () => {
  it("shows the selected project's details with Italian dates", async () => {
    withProjects([
      makeProject("Tesi magistrale", {
        description: "Capitolo 2 da rivedere",
        createdAt: "2026-03-10T09:00:00Z",
        updatedAt: "2026-03-10T09:00:00Z",
      }),
    ]);
    renderApp();

    const detail = await screen.findByRole("region", { name: "Tesi magistrale" });
    expect(within(detail).getByText("Capitolo 2 da rivedere")).toBeInTheDocument();
    expect(within(detail).getAllByText(/10 marzo 2026/)).toHaveLength(2);
  });

  it("moves the selection with the arrow keys", async () => {
    withProjects([makeProject("Primo"), makeProject("Secondo")]);
    const user = renderApp();

    const first = await screen.findByRole("option", { name: "Primo" });
    expect(first).toHaveAttribute("aria-selected", "true");
    first.focus();
    await user.keyboard("{ArrowDown}");
    const second = screen.getByRole("option", { name: "Secondo" });
    expect(second).toHaveAttribute("aria-selected", "true");
    expect(second).toHaveFocus();
    expect(screen.getByRole("region", { name: "Secondo" })).toBeInTheDocument();
  });

  it("creates a project, adds it to the list and selects it", async () => {
    withProjects([makeProject("Esistente")]);
    const created = makeProject("Fisica 2", { description: "Elettromagnetismo" });
    let resolveCreate!: (p: Project) => void;
    mockedApi.createProject.mockImplementation(() => new Promise((resolve) => (resolveCreate = resolve)));
    const user = renderApp();

    await user.click(await screen.findByRole("button", { name: "Nuovo progetto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo progetto" });
    await user.type(within(dialog).getByLabelText("Nome"), "  Fisica 2 ");
    await user.type(within(dialog).getByLabelText(/Descrizione/), "Elettromagnetismo");
    await user.click(within(dialog).getByRole("button", { name: "Crea progetto" }));

    expect(within(dialog).getByRole("button", { name: "Crea progetto" })).toBeDisabled();
    expect(mockedApi.createProject).toHaveBeenCalledWith({ name: "Fisica 2", description: "Elettromagnetismo" });

    await act(async () => resolveCreate(created));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const option = screen.getByRole("option", { name: "Fisica 2" });
    expect(option).toHaveAttribute("aria-selected", "true");
    expect(option).toHaveFocus();
    expect(screen.getByRole("region", { name: "Fisica 2" })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("rejects an empty name client-side, next to the field, with focus", async () => {
    withProjects([]);
    const user = renderApp();

    await user.click(await screen.findByRole("button", { name: "Nuovo progetto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo progetto" });
    await user.type(within(dialog).getByLabelText(/Descrizione/), "solo descrizione");
    await user.type(within(dialog).getByLabelText("Nome"), "   ");
    await user.click(within(dialog).getByRole("button", { name: "Crea progetto" }));

    const name = within(dialog).getByLabelText("Nome");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription("Inserisci un nome.");
    await waitFor(() => expect(name).toHaveFocus());
    expect(mockedApi.createProject).not.toHaveBeenCalled();
  });

  it("shows a backend field error (duplicate) next to the field and focuses it", async () => {
    withProjects([makeProject("Analisi 1")]);
    const error: AppError = { code: "duplicate", field: "name", message: "Esiste già un progetto con questo nome." };
    mockedApi.createProject.mockRejectedValue(error);
    const user = renderApp();

    await user.click(await screen.findByRole("button", { name: "Nuovo progetto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo progetto" });
    await user.type(within(dialog).getByLabelText("Nome"), "analisi 1");
    await user.click(within(dialog).getByLabelText(/Descrizione/));
    await user.click(within(dialog).getByRole("button", { name: "Crea progetto" }));

    const name = within(dialog).getByLabelText("Nome");
    await waitFor(() => expect(name).toHaveAttribute("aria-invalid", "true"));
    expect(name).toHaveAccessibleDescription("Esiste già un progetto con questo nome.");
    await waitFor(() => expect(name).toHaveFocus());
    expect(within(dialog).getByRole("button", { name: "Crea progetto" })).toBeEnabled();
  });

  it("shows non-field backend errors in a banner with expandable details", async () => {
    withProjects([]);
    mockedApi.createProject.mockRejectedValue({
      code: "storage",
      message: "Impossibile salvare il progetto.",
      detail: "database is locked",
    } satisfies AppError);
    const user = renderApp();

    await user.click(await screen.findByRole("button", { name: "Nuovo progetto" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo progetto" });
    await user.type(within(dialog).getByLabelText("Nome"), "Ricerca");
    await user.click(within(dialog).getByRole("button", { name: "Crea progetto" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Impossibile salvare il progetto.");
    expect(within(alert).getByText("Dettagli")).toBeInTheDocument();
    expect(within(alert).getByText("database is locked")).not.toBeVisible();
  });

  it("shows a counter near the name length limit", async () => {
    withProjects([]);
    const user = renderApp();
    await user.click(await screen.findByRole("button", { name: "Nuovo progetto" }));
    const name = screen.getByLabelText("Nome");
    expect(screen.queryByText(/\/120$/)).not.toBeInTheDocument();
    await user.click(name);
    await user.paste("x".repeat(110));
    expect(screen.getByText("110/120")).toBeInTheDocument();
  });

  it("shows the loading indicator only when loading takes a while", async () => {
    mockedApi.listProjects.mockReturnValue(new Promise(() => {}));
    renderApp();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Caricamento…");
  });

  it("shows a load error with «Riprova» that reloads", async () => {
    mockedApi.listProjects.mockRejectedValueOnce({ code: "storage", message: "Impossibile leggere i progetti." });
    mockedApi.listProjects.mockResolvedValueOnce([makeProject("Recuperato")]);
    const user = renderApp();

    expect(await screen.findByText("Impossibile leggere i progetti.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Riprova" }));
    expect(await screen.findByRole("option", { name: "Recuperato" })).toBeInTheDocument();
  });
});

describe("delete", () => {
  it("cancel (button or Esc) makes no API call, keeps the project and returns focus", async () => {
    withProjects([makeProject("Da tenere")]);
    const user = renderApp();

    const trigger = await screen.findByRole("button", { name: "Elimina" });
    await user.click(trigger);
    let dialog = screen.getByRole("alertdialog", { name: "Eliminare «Da tenere»?" });
    expect(dialog).toHaveAccessibleDescription(
      "Il progetto verrà rimosso da Localis insieme ai suoi documenti e alle copie degli originali conservate da Localis. I file sul tuo disco non vengono toccati.",
    );
    const cancel = within(dialog).getByRole("button", { name: "Annulla" });
    expect(cancel).toHaveFocus();
    await user.click(cancel);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = screen.getByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    expect(mockedApi.deleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Da tenere" })).toBeInTheDocument();
  });

  it("confirm removes the project and selects the next one, then the previous, then the empty state", async () => {
    const a = makeProject("Alfa");
    const b = makeProject("Beta");
    const c = makeProject("Gamma");
    withProjects([a, b, c]);
    mockedApi.deleteProject.mockResolvedValue(undefined);
    const user = renderApp();

    await user.click(await screen.findByRole("option", { name: "Beta" }));
    await user.click(screen.getByRole("button", { name: "Elimina" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Elimina" }));

    expect(mockedApi.deleteProject).toHaveBeenCalledWith(b.id);
    await waitFor(() => expect(screen.queryByRole("option", { name: "Beta" })).not.toBeInTheDocument());
    const gamma = screen.getByRole("option", { name: "Gamma" });
    expect(gamma).toHaveAttribute("aria-selected", "true");
    expect(gamma).toHaveFocus();

    // Last item: selection moves to the previous one.
    await user.click(screen.getByRole("button", { name: "Elimina" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Elimina" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "Alfa" })).toHaveAttribute("aria-selected", "true"));

    await user.click(screen.getByRole("button", { name: "Elimina" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Elimina" }));
    expect(await screen.findByText(/Nessun progetto/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Nuovo progetto" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Benvenuto in Localis" })).not.toBeInTheDocument();
  });

  it("keeps the dialog open and shows the error when deletion fails", async () => {
    withProjects([makeProject("Bloccato")]);
    mockedApi.deleteProject.mockRejectedValue({ code: "storage", message: "Impossibile eliminare il progetto." });
    const user = renderApp();

    await user.click(await screen.findByRole("button", { name: "Elimina" }));
    const dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Elimina" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Impossibile eliminare il progetto.");
    expect(screen.getByRole("option", { name: "Bloccato" })).toBeInTheDocument();
  });
});

describe("settings", () => {
  it("persists the theme and applies data-theme immediately", async () => {
    withProjects([]);
    const user = renderApp();

    await user.click(screen.getByRole("button", { name: "Impostazioni" }));
    expect(screen.getByRole("heading", { level: 1, name: "Impostazioni" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Sistema" })).toBeChecked();

    await user.click(screen.getByRole("radio", { name: "Scuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(window.localStorage.getItem("localis.theme")).toBe("dark");

    await user.click(screen.getByRole("radio", { name: "Chiaro" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.getItem("localis.theme")).toBe("light");
  });

  it("follows the system color scheme live when set to Sistema", async () => {
    withProjects([]);
    window.localStorage.setItem("localis.theme", "system");
    renderApp();
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => setSystemDark(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    act(() => setSystemDark(false));
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});

describe("shell", () => {
  it("opens the Chat of the selected project and keeps it while visiting other views", async () => {
    const project = makeProject("Tesi");
    withProjects([makeProject("Corso"), project]);
    const user = renderApp();
    await user.click(await screen.findByRole("option", { name: "Tesi" }));

    const chat = screen.getByRole("button", { name: "Chat" });
    expect(chat).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText("Presto")).not.toBeInTheDocument();
    await user.click(chat);
    expect(chat).toHaveAttribute("aria-current", "page");
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    expect(screen.getByText("Tesi", { selector: ".view-context" })).toBeInTheDocument();
    expect(mockedApi.listConversations).toHaveBeenCalledWith(project.id);

    await user.click(screen.getByRole("button", { name: "Progetti" }));
    expect(screen.queryByRole("heading", { level: 1, name: "Chat" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chat" }));
    expect(screen.getByRole("heading", { level: 1, name: "Chat" })).toBeInTheDocument();
    expect(mockedApi.listConversations).toHaveBeenCalledTimes(1);
  });

  it("opens the Libreria of the selected project", async () => {
    const project = makeProject("Tesi");
    withProjects([makeProject("Corso"), project]);
    const user = renderApp();
    await user.click(await screen.findByRole("option", { name: "Tesi" }));

    await user.click(screen.getByRole("button", { name: "Libreria" }));
    expect(screen.getByRole("button", { name: "Libreria" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Libreria" })).toBeInTheDocument();
    expect(screen.getByText("Tesi", { selector: ".view-context" })).toBeInTheDocument();
    await waitFor(() => expect(mockedApi.listDocuments).toHaveBeenCalledWith(project.id));
  });

  it("Libreria without projects points to Progetti", async () => {
    withProjects([]);
    const user = renderApp();
    await screen.findByText(/Nessun progetto/);
    await user.click(screen.getByRole("button", { name: "Libreria" }));
    await user.click(screen.getByRole("button", { name: "Vai a Progetti" }));
    expect(screen.getByRole("heading", { level: 1, name: "Progetti" })).toBeInTheDocument();
  });

  it("shows the real document count in the project detail", async () => {
    withProjects([makeProject("Corso")]);
    mockedApi.listDocuments.mockResolvedValue([{} as never, {} as never]);
    renderApp();
    const term = await screen.findByText("Documenti");
    expect(term.nextElementSibling).toHaveTextContent("2");
  });

  it("collapses and hides the sidebar, persisting the state", async () => {
    withProjects([]);
    const user = renderApp();
    const nav = screen.getByRole("navigation", { name: "Principale" });

    await user.click(screen.getByRole("button", { name: "Comprimi barra laterale" }));
    expect(window.localStorage.getItem("localis.sidebar")).toBe("collapsed");
    // Icons-only items keep their accessible names.
    expect(within(nav).getByRole("button", { name: "Progetti" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Espandi barra laterale" })).toHaveAttribute("aria-expanded", "false");

    const toggle = screen.getByRole("button", { name: "Nascondi barra laterale" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls", "app-sidebar");
    await user.click(toggle);
    expect(window.localStorage.getItem("localis.sidebar")).toBe("hidden");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mostra barra laterale" })).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the stored sidebar state", () => {
    window.localStorage.setItem("localis.sidebar", "hidden");
    withProjects([]);
    renderApp();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
});
