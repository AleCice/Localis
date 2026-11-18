import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Folder, Job, LibraryDocument } from "../../api/types";
import { IMPORT_MAX_BYTES } from "../../api/types";
import { LIBRARY_PROJECT_ID, makeDocument, makeFolder, makeHit, makeJob, makeProject } from "../../test/fixtures";
import { LibraryView } from "./LibraryView";
import { openPdf } from "./pdfjs";

vi.mock("../../api/client", () => ({
  api: {
    listFolders: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    listDocuments: vi.fn(),
    listVersions: vi.fn(),
    importDocument: vi.fn(),
    importVersion: vi.fn(),
    moveDocument: vi.fn(),
    deleteDocument: vi.fn(),
    readOriginal: vi.fn(),
    getText: vi.fn(),
    search: vi.fn(),
    listJobs: vi.fn(),
    retryJob: vi.fn(),
  },
}));

// pdf.js cannot run in jsdom: the viewer talks to it only through ./pdfjs.
vi.mock("./pdfjs", () => ({
  openPdf: vi.fn(),
  isCancel: () => false,
}));

const mockedApi = vi.mocked(api);
const mockedOpenPdf = vi.mocked(openPdf);
const project = makeProject("Tesi", { id: LIBRARY_PROJECT_ID });

let state: { folders: Folder[]; documents: LibraryDocument[]; jobs: Job[] };

function withLibrary(next: Partial<typeof state>) {
  state = { folders: [], documents: [], jobs: [], ...next };
}

function renderLibrary(options: { applyAccept?: boolean } = {}) {
  const user = userEvent.setup(options);
  render(<LibraryView project={project} projectsStatus="ready" onGoToProjects={() => {}} sidebarToggle={null} />);
  return user;
}

function file(name: string, content = "contenuto", type = "text/plain") {
  return new File([content], name, { type, lastModified: Date.UTC(2026, 0, 2) });
}

const importInput = () => screen.getByTestId("import-input") as HTMLInputElement;

beforeEach(() => {
  vi.resetAllMocks();
  withLibrary({});
  mockedApi.listFolders.mockImplementation(async () => state.folders);
  mockedApi.listDocuments.mockImplementation(async () => state.documents);
  mockedApi.listJobs.mockImplementation(async () => state.jobs);
  mockedApi.listVersions.mockImplementation(async (id) => {
    const doc = state.documents.find((d) => d.id === id);
    return doc ? [doc.current] : [];
  });
  mockedApi.readOriginal.mockResolvedValue(new ArrayBuffer(8));
  mockedApi.getText.mockResolvedValue([]);
  mockedApi.search.mockResolvedValue([]);
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("import", () => {
  it("shows the empty state and imports a file with «Importa» into the open folder", async () => {
    const doc = makeDocument("appunti.txt", { kind: "text" });
    mockedApi.importDocument.mockImplementation(async () => {
      state.documents = [doc];
      return { status: "imported", document: doc };
    });
    const user = renderLibrary();

    expect(await screen.findByText(/Nessun documento\. Importa PDF/)).toBeInTheDocument();
    expect(importInput()).toHaveAttribute("accept", ".pdf,.txt,.md,.markdown,.docx,.png,.jpg,.jpeg,.gif,.webp");
    expect(importInput()).toHaveAttribute("multiple");

    await user.upload(importInput(), file("appunti.txt", "ciao"));

    expect(await screen.findByText("Importazione completata: 1 importato.")).toBeInTheDocument();
    const [bytes, meta] = mockedApi.importDocument.mock.calls[0]!;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe("ciao");
    expect(meta).toEqual({
      projectId: project.id,
      folderId: null,
      fileName: "appunti.txt",
      lastModified: Date.UTC(2026, 0, 2),
    });
    // A single imported file is opened.
    expect(await screen.findByRole("heading", { level: 2, name: "appunti.txt" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Documenti" })).getByRole("button", { name: /^appunti\.txt/ }),
    ).toBeInTheDocument();
  });

  it("reports a duplicate as «Già presente» and selects the existing document", async () => {
    const existing = makeDocument("lezione.pdf");
    withLibrary({ documents: [existing] });
    mockedApi.importDocument.mockResolvedValue({ status: "duplicate", document: existing });
    const user = renderLibrary();
    await screen.findByRole("button", { name: /^lezione\.pdf/ });

    await user.upload(importInput(), file("copia.pdf", "%PDF-", "application/pdf"));

    expect(await screen.findByText("Importazione completata: 1 già presente.")).toBeInTheDocument();
    expect(screen.getByText(/Già presente/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "lezione.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^lezione\.pdf/ }).closest("li")).toHaveAttribute("aria-current", "true");
  });

  it("checks the size client-side and shows backend errors per file, sequentially", async () => {
    const big = file("enorme.pdf");
    Object.defineProperty(big, "size", { value: IMPORT_MAX_BYTES + 1 });
    mockedApi.importDocument.mockImplementation(async (_bytes, meta) => {
      if (meta.fileName === "virus.exe")
        throw { code: "unsupported", message: "Formato non supportato: .exe", detail: "magic bytes 4d5a" };
      const doc = makeDocument(meta.fileName, { kind: "text" });
      state.documents = [...state.documents, doc];
      return { status: "imported", document: doc };
    });
    const user = renderLibrary({ applyAccept: false });
    await screen.findByText(/Nessun documento\. Importa PDF/);

    // Not in `accept`, but a drop or a permissive picker can still pass it.
    await user.upload(importInput(), [big, file("virus.exe"), file("note.txt")]);

    expect(await screen.findByText("Importazione completata: 1 importato, 2 non importati.")).toBeInTheDocument();
    expect(mockedApi.importDocument.mock.calls.map(([, meta]) => meta.fileName)).toEqual(["virus.exe", "note.txt"]);
    const summary = screen.getByRole("region", { name: "Importazione" });
    expect(within(summary).getByText("Il file supera il limite di 200 MB.")).toBeInTheDocument();
    expect(within(summary).getByText("Formato non supportato: .exe")).toBeInTheDocument();
    expect(within(summary).getByText("Dettagli")).toBeInTheDocument();
    expect(within(summary).getByText("magic bytes 4d5a")).not.toBeVisible();

    await user.click(within(summary).getByRole("button", { name: "Chiudi riepilogo importazione" }));
    expect(screen.queryByRole("region", { name: "Importazione" })).not.toBeInTheDocument();
  });

  it("imports files dropped on the library", async () => {
    const doc = makeDocument("trascinato.md", { kind: "markdown" });
    mockedApi.importDocument.mockResolvedValue({ status: "imported", document: doc });
    renderLibrary();
    const empty = await screen.findByText(/Nessun documento\. Importa PDF/);
    const zone = empty.closest(".library")!;
    const dataTransfer = { types: ["Files"], files: [file("trascinato.md")], dropEffect: "none" };

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.dragEnter(zone, { dataTransfer });
    expect(screen.getByText(/Rilascia i file per importarli in «Tesi»/)).toBeInTheDocument();
    fireEvent.drop(zone, { dataTransfer });

    await waitFor(() => expect(mockedApi.importDocument).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Rilascia i file/)).not.toBeInTheDocument();
  });
});

describe("folders", () => {
  it("creates a folder inside the open folder and opens it", async () => {
    const parent = makeFolder("Capitoli");
    withLibrary({ folders: [parent] });
    const created = makeFolder("Capitolo 1", { parentId: parent.id });
    mockedApi.createFolder.mockImplementation(async () => {
      state.folders = [parent, created];
      return created;
    });
    const user = renderLibrary();
    const tree = await screen.findByRole("navigation", { name: "Cartelle" });

    await user.click(within(tree).getByRole("button", { name: "Capitoli" }));
    await user.click(screen.getByRole("button", { name: "Nuova cartella" }));
    const dialog = screen.getByRole("dialog", { name: "Nuova cartella" });
    expect(within(dialog).getByText("Dentro «Capitoli».")).toBeInTheDocument();

    // Empty name is rejected client-side.
    await user.click(within(dialog).getByRole("button", { name: "Crea cartella" }));
    expect(within(dialog).getByText("Inserisci un nome.")).toBeInTheDocument();
    expect(mockedApi.createFolder).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText("Nome"), "  Capitolo 1 ");
    await user.click(within(dialog).getByRole("button", { name: "Crea cartella" }));

    expect(mockedApi.createFolder).toHaveBeenCalledWith({
      projectId: project.id,
      parentId: parent.id,
      name: "Capitolo 1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const node = within(tree).getByRole("button", { name: "Capitolo 1" });
    expect(node).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(node).toHaveFocus());
    expect(within(tree).getByRole("button", { name: "Comprimi «Capitoli»" })).toHaveAttribute("aria-expanded", "true");
  });

  it("renames the open folder and shows a duplicate name next to the field", async () => {
    const folder = makeFolder("Bozze");
    withLibrary({ folders: [folder] });
    mockedApi.renameFolder
      .mockRejectedValueOnce({ code: "duplicate", field: "name", message: "Esiste già una cartella con questo nome." })
      .mockImplementationOnce(async (id, name) => {
        const renamed = { ...folder, id, name };
        state.folders = [renamed];
        return renamed;
      });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: "Bozze" }));

    await user.click(screen.getByRole("button", { name: "Rinomina la cartella «Bozze»" }));
    const dialog = screen.getByRole("dialog", { name: "Rinomina cartella" });
    const input = within(dialog).getByLabelText("Nome");
    expect(input).toHaveValue("Bozze");
    await user.clear(input);
    await user.type(input, "Archivio{Enter}");
    expect(await within(dialog).findByText("Esiste già una cartella con questo nome.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");

    await user.clear(input);
    await user.type(input, "Definitivi{Enter}");
    expect(mockedApi.renameFolder).toHaveBeenLastCalledWith(folder.id, "Definitivi");
    expect(await screen.findByRole("heading", { level: 2, name: "Definitivi" })).toBeInTheDocument();
  });

  it("deleting a non-empty folder shows the conflict and keeps the dialog open", async () => {
    const folder = makeFolder("Piena");
    withLibrary({ folders: [folder], documents: [makeDocument("dentro.pdf", { folderId: folder.id })] });
    mockedApi.deleteFolder.mockRejectedValue({ code: "conflict", message: "La cartella non è vuota." });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: "Piena" }));

    await user.click(screen.getByRole("button", { name: "Elimina la cartella «Piena»" }));
    const dialog = screen.getByRole("alertdialog", { name: "Eliminare la cartella «Piena»?" });
    await user.click(within(dialog).getByRole("button", { name: "Elimina" }));

    expect(mockedApi.deleteFolder).toHaveBeenCalledWith(folder.id);
    expect(await within(dialog).findByText("La cartella non è vuota.")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("deletes an empty folder and goes back to its parent", async () => {
    const folder = makeFolder("Vuota");
    withLibrary({ folders: [folder] });
    mockedApi.deleteFolder.mockImplementation(async () => {
      state.folders = [];
    });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: "Vuota" }));
    await user.click(screen.getByRole("button", { name: "Elimina la cartella «Vuota»" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Elimina" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Vuota" })).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 2, name: "Tesi" })).toBeInTheDocument();
  });
});

describe("documents", () => {
  it("moves a document to another folder from the information panel", async () => {
    const folder = makeFolder("Letture");
    const doc = makeDocument("saggio.pdf");
    withLibrary({ folders: [folder], documents: [doc] });
    mockedOpenPdf.mockResolvedValue({
      numPages: 3,
      pageSize: async () => ({ width: 600, height: 800 }),
      renderPage: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      destroy: () => {},
    });
    mockedApi.moveDocument.mockImplementation(async (_id, folderId) => {
      const moved = { ...doc, folderId };
      state.documents = [moved];
      return moved;
    });
    const user = renderLibrary();

    await user.click(await screen.findByRole("button", { name: /^saggio\.pdf/ }));
    const info = screen.getByRole("button", { name: "Informazioni" });
    expect(info).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("complementary", { name: "Informazioni sul documento" })).not.toBeInTheDocument();
    await user.click(info);
    const panel = screen.getByRole("complementary", { name: "Informazioni sul documento" });
    expect(within(panel).getByText("aaaaaaaa…aaaaaaaa")).toBeInTheDocument();

    await user.click(within(panel).getByRole("button", { name: "Sposta" }));
    const dialog = screen.getByRole("dialog", { name: "Sposta «saggio.pdf»" });
    expect(within(dialog).getByRole("button", { name: "Sposta" })).toBeDisabled();
    await user.click(within(dialog).getByRole("radio", { name: "Letture" }));
    await user.click(within(dialog).getByRole("button", { name: "Sposta" }));

    expect(mockedApi.moveDocument).toHaveBeenCalledWith(doc.id, folder.id);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      within(screen.getByRole("navigation", { name: "Cartelle" })).getByRole("button", { name: "Letture" }),
    ).toHaveAttribute("aria-current", "true");
  });

  it("delete asks for confirmation: cancel keeps it, confirm removes it", async () => {
    const doc = makeDocument("vecchio.txt", { kind: "text" });
    withLibrary({ documents: [doc] });
    mockedApi.deleteDocument.mockImplementation(async () => {
      state.documents = [];
    });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^vecchio\.txt/ }));
    await user.click(screen.getByRole("button", { name: "Informazioni" }));

    await user.click(screen.getByRole("button", { name: "Elimina" }));
    let dialog = screen.getByRole("alertdialog", { name: "Eliminare «vecchio.txt»?" });
    expect(dialog).toHaveAccessibleDescription(
      "Il documento verrà rimosso dalla libreria insieme alle copie di tutte le sue versioni conservate da Localis. I file sul tuo disco non vengono toccati.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.deleteDocument).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 2, name: "vecchio.txt" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Elimina" }));
    dialog = screen.getByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Elimina" }));
    expect(mockedApi.deleteDocument).toHaveBeenCalledWith(doc.id);
    expect(await screen.findByText("Seleziona un documento per visualizzarlo.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^vecchio\.txt/ })).not.toBeInTheDocument();
  });

  it("shows an integrity error from the archive plainly", async () => {
    const doc = makeDocument("rotto.pdf");
    withLibrary({ documents: [doc] });
    mockedApi.readOriginal.mockRejectedValue({
      code: "integrity",
      message: "Il file originale nell'archivio risulta alterato.",
      detail: "sha mismatch",
    });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^rotto\.pdf/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Il file originale nell'archivio risulta alterato.");
    expect(mockedOpenPdf).not.toHaveBeenCalled();
  });

  it("shows an image from a blob URL with the title as alt text", async () => {
    const doc = makeDocument("schema.png", { kind: "image" });
    withLibrary({ documents: [doc] });
    const user = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^schema\.png/ }));
    const img = await screen.findByRole("img", { name: "schema.png" });
    expect(img).toHaveAttribute("src", "blob:mock");
    expect(mockedApi.readOriginal).toHaveBeenCalledWith(doc.current.id);
  });
});

describe("text status", () => {
  it("labels every status honestly and «Riprova» requeues the failed job", async () => {
    const pending = makeDocument("a-in-corso.pdf", { status: "pending" });
    const extracted = makeDocument("b-ricercabile.pdf", { status: "extracted" });
    const noText = makeDocument("c-scansione.pdf", { status: "no_text" });
    const failed = makeDocument("d-rotto.docx", { kind: "docx", status: "failed" });
    const image = makeDocument("e-foto.png", { kind: "image" });
    const failedJob = makeJob(failed, { state: "failed", error: "Non è stato possibile estrarre il testo." });
    withLibrary({
      documents: [pending, extracted, noText, failed, image],
      jobs: [failedJob, makeJob(pending, { state: "running" })],
    });
    mockedApi.retryJob.mockResolvedValue({ ...failedJob, state: "queued" });
    const user = renderLibrary();

    const list = await screen.findByRole("list", { name: "Documenti" });
    const row = (title: string) =>
      within(list)
        .getByRole("button", { name: new RegExp(`^${title}`) })
        .closest("li")!;
    expect(row("a-in-corso")).toHaveTextContent("Estrazione in corso…");
    expect(row("b-ricercabile")).not.toHaveTextContent(/Ricercabile|Estrazione|testo/);
    expect(row("c-scansione")).toHaveTextContent("Senza testo ricercabile");
    expect(within(row("c-scansione")).getByText("Senza testo ricercabile").parentElement).toHaveAttribute(
      "title",
      expect.stringContaining("OCR"),
    );
    expect(row("d-rotto")).toHaveTextContent("Estrazione non riuscita");
    expect(row("e-foto")).toHaveTextContent("Non ricercabile");

    await user.click(within(row("d-rotto")).getByRole("button", { name: "Riprova l'estrazione di «d-rotto.docx»" }));
    expect(mockedApi.retryJob).toHaveBeenCalledWith(failedJob.id);
  });

  it("hides «Riprova» when there is no failed job to retry", async () => {
    withLibrary({ documents: [makeDocument("x.docx", { kind: "docx", status: "failed" })] });
    renderLibrary();
    expect(await screen.findByText("Estrazione non riuscita")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Riprova/ })).not.toBeInTheDocument();
  });

  it("polls about every second while a job is pending and stops when idle", async () => {
    vi.useFakeTimers();
    const doc = makeDocument("lungo.pdf", { status: "pending" });
    withLibrary({ documents: [doc], jobs: [makeJob(doc, { state: "queued" })] });
    render(<LibraryView project={project} projectsStatus="ready" onGoToProjects={() => {}} sidebarToggle={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedApi.listDocuments).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Estrazione in corso…")).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockedApi.listDocuments).toHaveBeenCalledTimes(2);
    expect(mockedApi.listJobs).toHaveBeenCalledTimes(2);

    // Extraction finishes: the next poll sees it and polling stops.
    state.documents = [{ ...doc, current: { ...doc.current, textStatus: "extracted" } }];
    state.jobs = [makeJob(doc, { state: "done" })];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mockedApi.listDocuments).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Estrazione in corso…")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockedApi.listDocuments).toHaveBeenCalledTimes(3);
  });
});

describe("search", () => {
  it("renders snippet markers as <mark> and any markup in the text as text", async () => {
    const doc = makeDocument("fonti.txt", { kind: "text" });
    withLibrary({ documents: [doc] });
    mockedApi.search.mockResolvedValue([
      makeHit(doc, 4, "prima \u0002<img src=x onerror=alert(1)>\u0003 e \u0002termine\u0003 dopo…"),
    ]);
    const user = renderLibrary();
    await screen.findByRole("button", { name: /^fonti\.txt/ });

    await user.type(screen.getByRole("searchbox", { name: "Cerca nei documenti" }), "termine");
    const results = await screen.findByRole("region", { name: "Risultati per «termine»" });
    // Debounced: the search runs for the full term (under heavy load a partial term may run too).
    expect(mockedApi.search).toHaveBeenLastCalledWith(project.id, "termine");
    await waitFor(() =>
      expect([...results.querySelectorAll("mark")].map((m) => m.textContent)).toEqual([
        "<img src=x onerror=alert(1)>",
        "termine",
      ]),
    );
    expect(results.querySelector("img")).toBeNull();
    expect(within(results).getByText("blocco 4")).toBeInTheDocument();
  });

  it("says «Nessun risultato.» and notes documents not covered", async () => {
    withLibrary({ documents: [makeDocument("scansione.pdf", { status: "no_text" })] });
    const user = renderLibrary();
    await screen.findByRole("button", { name: /^scansione\.pdf/ });
    await user.type(screen.getByRole("searchbox", { name: "Cerca nei documenti" }), "nulla{Enter}");
    expect(await screen.findByText("Nessun risultato.")).toBeInTheDocument();
    expect(
      screen.getByText(/La ricerca copre solo il testo estratto: 1 documento non è incluso\./),
    ).toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Cerca nei documenti" }));
    expect(await screen.findByRole("list", { name: "Documenti" })).toBeInTheDocument();
  });

  it("opens a PDF result at its page", async () => {
    const doc = makeDocument("manuale.pdf");
    withLibrary({ documents: [doc] });
    const renderPage = vi.fn(() => ({ promise: Promise.resolve(), cancel: () => {} }));
    mockedOpenPdf.mockResolvedValue({
      numPages: 5,
      pageSize: async () => ({ width: 600, height: 800 }),
      renderPage,
      destroy: () => {},
    });
    mockedApi.search.mockResolvedValue([makeHit(doc, 3, "a \u0002b\u0003 c")]);
    const user = renderLibrary();
    await screen.findByRole("button", { name: /^manuale\.pdf/ });

    await user.type(screen.getByRole("searchbox", { name: "Cerca nei documenti" }), "b{Enter}");
    const result = await screen.findByRole("button", { name: /^manuale\.pdf\s*p\. 3/ });
    await user.click(result);

    expect(await screen.findByRole("textbox", { name: /Pagina/ })).toHaveValue("3");
    expect(screen.getByRole("region", { name: "Pagina 3 di 5" })).toBeInTheDocument();
    expect(mockedApi.readOriginal).toHaveBeenCalledWith(doc.current.id);
    await waitFor(() => expect(renderPage).toHaveBeenLastCalledWith(3, expect.any(HTMLCanvasElement), 1));

    // Keyboard and buttons move between pages.
    await user.click(screen.getByRole("button", { name: "Pagina successiva" }));
    expect(screen.getByRole("textbox", { name: /Pagina/ })).toHaveValue("4");
    screen.getByRole("region", { name: "Pagina 4 di 5" }).focus();
    await user.keyboard("{End}");
    expect(screen.getByRole("textbox", { name: /Pagina/ })).toHaveValue("5");
    expect(screen.getByRole("button", { name: "Pagina successiva" })).toBeDisabled();
  });

  it("opens a text result scrolled to its block, highlighted and focused", async () => {
    const doc = makeDocument("note.md", { kind: "markdown" });
    withLibrary({ documents: [doc] });
    mockedApi.getText.mockResolvedValue([
      { unit: 1, text: "# Titolo" },
      { unit: 2, text: "Il blocco cercato." },
      { unit: 3, text: "Altro." },
    ]);
    mockedApi.search.mockResolvedValue([makeHit(doc, 2, "Il blocco \u0002cercato\u0003.")]);
    const user = renderLibrary();
    await screen.findByRole("button", { name: /^note\.md/ });

    await user.type(screen.getByRole("searchbox", { name: "Cerca nei documenti" }), "cercato{Enter}");
    await user.click(await screen.findByRole("button", { name: /^note\.md\s*blocco 2/ }));

    expect(await screen.findByRole("heading", { name: "Testo estratto" })).toBeInTheDocument();
    expect(screen.getByText(/mostrato senza formattazione/)).toBeInTheDocument();
    const block = await screen.findByText("Il blocco cercato.");
    await waitFor(() => expect(block).toHaveFocus());
    expect(block).toHaveClass("is-target");
    expect(screen.getByText("# Titolo")).not.toHaveClass("is-target");
  });
});
