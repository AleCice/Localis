// v0.5 FARO in the Library: chunked import, transcription status, media viewer, transcript,
// transcription dialog, timeline links (with regions) and backlinks.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Folder, Job, LibraryDocument, MediaLink, TranscriptSegment, WhisperModel } from "../../api/types";
import { MEDIA_IMPORT_MAX_BYTES } from "../../api/types";
import type { LibraryLink } from "../../lib/navigation";
import {
  LIBRARY_PROJECT_ID,
  makeDocument,
  makeHit,
  makeJob,
  makeLink,
  makeProject,
  makeSegments,
  makeWhisperModel,
} from "../../test/fixtures";
import { LibraryView } from "./LibraryView";
import { openPdf } from "./pdfjs";

vi.mock("../../api/client", () => ({
  api: {
    listFolders: vi.fn(),
    listDocuments: vi.fn(),
    listVersions: vi.fn(),
    importDocument: vi.fn(),
    readOriginal: vi.fn(),
    getText: vi.fn(),
    search: vi.fn(),
    listJobs: vi.fn(),
    retryJob: vi.fn(),
    beginUpload: vi.fn(),
    uploadChunk: vi.fn(),
    finishUpload: vi.fn(),
    cancelUpload: vi.fn(),
    mediaUrl: vi.fn(),
    listWhisperModels: vi.fn(),
    downloadWhisperModel: vi.fn(),
    cancelWhisperDownload: vi.fn(),
    startTranscription: vi.fn(),
    cancelJob: vi.fn(),
    getTranscript: vi.fn(),
    listMediaLinks: vi.fn(),
    listLinksForTarget: vi.fn(),
    createMediaLink: vi.fn(),
    updateMediaLink: vi.fn(),
    deleteMediaLink: vi.fn(),
  },
}));

vi.mock("./pdfjs", () => ({
  openPdf: vi.fn(),
  isCancel: () => false,
}));

const mockedApi = vi.mocked(api);
const mockedOpenPdf = vi.mocked(openPdf);
const project = makeProject("Analisi", { id: LIBRARY_PROJECT_ID });

let state: { folders: Folder[]; documents: LibraryDocument[]; jobs: Job[] };
let segments: TranscriptSegment[];
let links: MediaLink[];
let backlinks: MediaLink[];
let models: WhisperModel[];
const times = new WeakMap<HTMLMediaElement, number>();
let play: ReturnType<typeof vi.fn>;

function withLibrary(next: Partial<typeof state>) {
  state = { folders: [], documents: [], jobs: [], ...next };
}

function renderLibrary(link: LibraryLink | null = null) {
  const user = userEvent.setup();
  const view = render(
    <LibraryView project={project} projectsStatus="ready" onGoToProjects={() => {}} sidebarToggle={null} link={link} />,
  );
  return { user, ...view };
}

const media = () => document.querySelector<HTMLMediaElement>("audio, video")!;
const currentTime = () => times.get(media()) ?? 0;

function transcribed(title = "lezione.mp3", overrides: Parameters<typeof makeDocument>[1] = {}) {
  return makeDocument(title, {
    kind: "audio",
    status: "extracted",
    ...overrides,
    version: {
      transcription: { model: "small", language: "it", createdAt: "2026-03-10T10:00:00.000Z", segmentCount: 6 },
      ...overrides.version,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  withLibrary({});
  segments = makeSegments(6);
  links = [];
  backlinks = [];
  models = [makeWhisperModel("tiny"), makeWhisperModel("small")];
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
  mockedApi.mediaUrl.mockImplementation((id) => `http://localis-media.localhost/${id}`);
  mockedApi.getTranscript.mockImplementation(async () => segments);
  mockedApi.listMediaLinks.mockImplementation(async () => links);
  mockedApi.listLinksForTarget.mockImplementation(async () => backlinks);
  mockedApi.listWhisperModels.mockImplementation(async () => models);
  mockedOpenPdf.mockResolvedValue({
    numPages: 3,
    pageSize: async () => ({ width: 600, height: 800 }),
    renderPage: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    destroy: () => {},
  });
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
  // jsdom implements no media playback: keep currentTime per element and stub play/pause.
  Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return times.get(this) ?? 0;
    },
    set(this: HTMLMediaElement, value: number) {
      times.set(this, value);
    },
  });
  play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.play = play as unknown as HTMLMediaElement["play"];
  HTMLMediaElement.prototype.pause = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe("document list (transcription status)", () => {
  it("shows duration and honest labels, with «Riprova» for a failed transcription", async () => {
    const todo = makeDocument("da-fare.mp3", { kind: "audio" });
    const running = makeDocument("in-corso.mp4", { kind: "video" });
    const done = transcribed("fatta.m4a");
    const silent = makeDocument("silenzio.wav", { kind: "audio", status: "no_text" });
    const failed = makeDocument("rotta.mp3", { kind: "audio", status: "failed" });
    const failedJob = makeJob(failed, { kind: "transcribe", state: "failed", error: "Codifica audio non supportata" });
    withLibrary({
      documents: [todo, running, done, silent, failed],
      jobs: [makeJob(running, { kind: "transcribe", state: "running", progress: 37 }), failedJob],
    });
    mockedApi.retryJob.mockImplementation(async () => {
      state.jobs = state.jobs.filter((j) => j.id !== failedJob.id);
      return { ...failedJob, state: "queued" };
    });
    const { user } = renderLibrary();

    const rowOf = async (title: string) => (await screen.findByRole("button", { name: new RegExp(`^${title}`) })).closest("li")!;
    expect(within(await rowOf("da-fare")).getByText("Da trascrivere")).toBeInTheDocument();
    expect(within(await rowOf("da-fare")).getByText("20:00")).toBeInTheDocument();
    expect(within(await rowOf("in-corso")).getByText("Trascrizione in corso 37 %")).toBeInTheDocument();
    expect(within(await rowOf("fatta")).getByText("Trascritta (Whisper small)")).toBeInTheDocument();
    expect(within(await rowOf("silenzio")).getByText("Nessun parlato rilevato")).toBeInTheDocument();
    const failedRow = await rowOf("rotta");
    expect(within(failedRow).getByText("Trascrizione non riuscita")).toBeInTheDocument();
    await user.click(within(failedRow).getByRole("button", { name: "Riprova la trascrizione di «rotta.mp3»" }));
    expect(mockedApi.retryJob).toHaveBeenCalledWith(failedJob.id);
  });
});

describe("chunked import", () => {
  it("imports audio in chunks with a per-file progress bar and cancels with «Annulla»", async () => {
    mockedApi.beginUpload.mockResolvedValue({ uploadId: "up-1", chunkBytes: 4 });
    let release!: () => void;
    mockedApi.uploadChunk.mockImplementation(
      (_id, offset) => (offset === 0 ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
    );
    mockedApi.cancelUpload.mockResolvedValue(undefined);
    const { user } = renderLibrary();
    await screen.findByText(/Nessun documento/);

    const file = new File(["0123456789"], "lezione.mp3", { type: "audio/mpeg" });
    await user.upload(screen.getByTestId("import-input"), file);
    const bar = await screen.findByRole("progressbar", { name: "Importazione di lezione.mp3" });
    expect(bar).toHaveAttribute("value", "0");
    expect(mockedApi.beginUpload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: project.id, fileName: "lezione.mp3", sizeBytes: 10, documentId: null }),
    );
    expect(mockedApi.importDocument).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Annulla" }));
    await act(async () => release());
    expect(await screen.findByText("Importazione completata: 1 annullato.")).toBeInTheDocument();
    expect(mockedApi.cancelUpload).toHaveBeenCalledWith("up-1");
    expect(mockedApi.uploadChunk).toHaveBeenCalledTimes(1);
    expect(mockedApi.finishUpload).not.toHaveBeenCalled();
    expect(screen.getByText("Annullato")).toBeInTheDocument();
  });

  it("finishes a chunked import and refuses media over 4 GB before sending", async () => {
    const doc = makeDocument("lezione.wav", { kind: "audio" });
    mockedApi.beginUpload.mockResolvedValue({ uploadId: "up-2", chunkBytes: 8 });
    mockedApi.uploadChunk.mockResolvedValue(undefined);
    mockedApi.finishUpload.mockImplementation(async () => {
      state.documents = [doc];
      return { status: "imported", document: doc };
    });
    const { user } = renderLibrary();
    await screen.findByText(/Nessun documento/);
    const big = new File(["x"], "enorme.mp4");
    Object.defineProperty(big, "size", { value: MEDIA_IMPORT_MAX_BYTES + 1 });
    await user.upload(screen.getByTestId("import-input"), [new File(["RIFF0000WAVE"], "lezione.wav"), big]);
    expect(await screen.findByText(/Importazione completata: 1 importato, 1 non importato/)).toBeInTheDocument();
    expect(screen.getByText("Il file supera il limite di 4 GB.")).toBeInTheDocument();
    expect(mockedApi.uploadChunk.mock.calls.map((c) => c[1])).toEqual([0, 8]);
    expect(mockedApi.beginUpload).toHaveBeenCalledTimes(1);
  });
});

describe("media viewer and transcript", () => {
  it("seeks when a timestamp is clicked, highlights the current segment and follows it", async () => {
    const doc = transcribed();
    withLibrary({ documents: [doc] });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));

    expect(await screen.findByText("Trascrizione automatica (Whisper small) — può contenere errori")).toBeInTheDocument();
    expect(media()).toHaveAttribute("src", `http://localis-media.localhost/${doc.current.id}`);
    expect(media()).toHaveAttribute("controls");

    await user.click(screen.getByRole("button", { name: /^Vai a 00:20/ }));
    expect(currentTime()).toBe(20);
    expect(play).toHaveBeenCalled();
    const seg3 = screen.getByText("Frase sintetica numero 3 della lezione.").closest("li")!;
    expect(seg3).toHaveAttribute("aria-current", "time");

    // Playback moves on: the highlight follows and the list scrolls to it.
    scroll.mockClear();
    times.set(media(), 41);
    fireEvent.timeUpdate(media());
    const seg5 = screen.getByText("Frase sintetica numero 5 della lezione.").closest("li")!;
    expect(seg5).toHaveAttribute("aria-current", "time");
    expect(seg3).not.toHaveAttribute("aria-current");
    expect(scroll).toHaveBeenCalled();

    // «Segui la riproduzione» off: highlight still moves, the list does not scroll.
    await user.click(screen.getByRole("checkbox", { name: "Segui la riproduzione" }));
    scroll.mockClear();
    times.set(media(), 55);
    fireEvent.timeUpdate(media());
    expect(screen.getByText("Frase sintetica numero 6 della lezione.").closest("li")).toHaveAttribute("aria-current", "time");
    expect(scroll).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("localis.transcript.follow")).toBe("false");
  });

  it("filters the transcript and handles space and arrows on the focused player", async () => {
    withLibrary({ documents: [transcribed()] });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    await screen.findByText("Frase sintetica numero 1 della lezione.");

    await user.type(screen.getByRole("searchbox", { name: "Cerca nella trascrizione" }), "numero 4");
    expect(screen.getByText("1 segmento trovato.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Segmenti della trascrizione" })).getAllByRole("listitem")).toHaveLength(1);

    const player = screen.getByRole("region", { name: /^Lettore: lezione\.mp3/ });
    player.focus();
    await user.keyboard(" ");
    expect(play).toHaveBeenCalledTimes(1);
    times.set(media(), 30);
    await user.keyboard("{ArrowRight}");
    expect(currentTime()).toBe(35);
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(currentTime()).toBe(25);
  });

  it("opens at a search hit on a segment: shows its timestamp, seeks to startMs and marks the segment", async () => {
    const doc = transcribed();
    withLibrary({ documents: [doc] });
    mockedApi.search.mockResolvedValue([{ ...makeHit(doc, 3, "la \u0002frase\u0003 tre"), startMs: 20_000 }]);
    const { user } = renderLibrary();
    await screen.findByRole("button", { name: /^lezione\.mp3/ });
    await user.type(screen.getByRole("searchbox", { name: "Cerca nei documenti" }), "frase{Enter}");
    const hit = await screen.findByRole("button", { name: /lezione\.mp3.*00:20/ });
    await user.click(hit);
    await screen.findByText("Frase sintetica numero 3 della lezione.");
    expect(currentTime()).toBe(20);
    expect(screen.getByText("Frase sintetica numero 3 della lezione.").closest("li")).toHaveClass("is-target");
  });

  it("opens a cited segment from the chat at startMs", async () => {
    const doc = transcribed();
    withLibrary({ documents: [doc] });
    renderLibrary({
      documentId: doc.id,
      versionId: doc.current.id,
      unit: 2,
      unitKind: "segment",
      startMs: 10_000,
      snippet: "Frase sintetica numero 2 della lezione.",
      nonce: 1,
    });
    expect(await screen.findByRole("heading", { name: "Passaggio citato · 00:00:10" })).toBeInTheDocument();
    await waitFor(() => expect(currentTime()).toBe(10));
    expect((await screen.findByText("Frase sintetica numero 2 della lezione.", { selector: ".segment-text" })).closest("li")).toHaveClass("is-target");
  });
});

describe("transcription", () => {
  it("requires confirming the download of a model that is not installed, then starts locally", async () => {
    const doc = makeDocument("lezione.mp3", { kind: "audio" });
    withLibrary({ documents: [doc] });
    mockedApi.downloadWhisperModel.mockImplementation(async (id) => {
      models = models.map((m) => (m.id === id ? { ...m, installed: true } : m));
      return models;
    });
    mockedApi.startTranscription.mockImplementation(async (versionId) => {
      const job = makeJob(doc, { kind: "transcribe", state: "queued", versionId });
      state.jobs = [job];
      return job;
    });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    await user.click(await screen.findByRole("button", { name: "Trascrivi" }));

    const dialog = screen.getByRole("dialog", { name: "Trascrivi «lezione.mp3»" });
    expect(await within(dialog).findByText("Nessun modello installato: scaricane uno per iniziare (serve una sola volta).")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Avvia la trascrizione" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: /Whisper Small/ })).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Scarica Whisper Small (465 MB)" }));
    const confirm = screen.getByRole("alertdialog", { name: "Scaricare Whisper Small?" });
    expect(confirm).toHaveTextContent("huggingface.co");
    expect(mockedApi.downloadWhisperModel).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole("button", { name: "Scarica (465 MB)" }));
    expect(mockedApi.downloadWhisperModel).toHaveBeenCalledWith("small");

    const small = await within(dialog).findByRole("radio", { name: /Whisper Small/ });
    await waitFor(() => expect(small).toBeEnabled());
    expect(small).toBeChecked();
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Lingua del parlato" }), "it");
    await user.click(within(dialog).getByRole("button", { name: "Avvia la trascrizione" }));
    expect(mockedApi.startTranscription).toHaveBeenCalledWith(doc.current.id, "small", "it");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trascrivi «lezione.mp3»" })).not.toBeInTheDocument());
  });

  it("shows progress of a running transcription and cancels the job", async () => {
    const doc = makeDocument("lezione.mp3", { kind: "audio", status: "pending" });
    const job = makeJob(doc, { kind: "transcribe", state: "running", progress: 37 });
    withLibrary({ documents: [doc], jobs: [job] });
    mockedApi.cancelJob.mockImplementation(async () => {
      state.jobs = [{ ...job, state: "failed", error: "Trascrizione annullata." }];
      state.documents = [{ ...doc, current: { ...doc.current, textStatus: "not_applicable" } }];
      return state.jobs[0]!;
    });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    const viewer = screen.getByRole("article");
    expect(within(viewer).getByRole("progressbar", { name: "Avanzamento della trascrizione" })).toHaveAttribute("value", "37");
    expect(within(viewer).getByText("Trascrizione in corso 30 %.")).toBeInTheDocument();
    await user.click(within(viewer).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.cancelJob).toHaveBeenCalledWith(job.id);
    expect(await within(viewer).findByText("Trascrizione annullata.")).toBeInTheDocument();
    // A cancelled job is not a failure: the recording is simply still to transcribe.
    expect(within(viewer).getByText("Da trascrivere")).toBeInTheDocument();
    expect(within(viewer).getByRole("button", { name: "Trascrivi" })).toBeInTheDocument();
  });
});

describe("links between recordings and pages", () => {
  const slides = () => makeDocument("slide.pdf", { kind: "pdf" });

  it("validates the interval, the page and the region, then creates the link", async () => {
    const doc = transcribed();
    const pdf = slides();
    withLibrary({ documents: [doc, pdf] });
    mockedApi.createMediaLink.mockImplementation(async (input) => {
      const link = makeLink(doc, pdf, { ...input, targetPage: input.targetPage ?? null, region: input.region ?? null, note: input.note ?? null });
      links = [link];
      return link;
    });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    await user.click(await screen.findByRole("button", { name: "Nuovo collegamento" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo collegamento" });
    const create = within(dialog).getByRole("button", { name: "Crea collegamento" });

    await user.click(create);
    expect(within(dialog).getByRole("textbox", { name: "Inizio" })).toHaveAccessibleDescription(/Indica l'inizio come mm:ss/);
    expect(within(dialog).getByRole("textbox", { name: "Inizio" })).toHaveFocus();
    expect(within(dialog).getByText("Scegli un PDF o un'immagine del progetto.")).toBeInTheDocument();

    await user.type(within(dialog).getByRole("textbox", { name: "Inizio" }), "15:00");
    await user.type(within(dialog).getByRole("textbox", { name: "Fine" }), "12:30");
    await user.click(create);
    expect(within(dialog).getByText("La fine deve venire dopo l'inizio.")).toBeInTheDocument();

    await user.clear(within(dialog).getByRole("textbox", { name: "Fine" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Fine" }), "25:00");
    await user.click(create);
    expect(within(dialog).getByText("La fine supera la durata della registrazione (20:00).")).toBeInTheDocument();

    // «Imposta all'istante attuale» takes the player position.
    times.set(media(), 750);
    await user.click(within(dialog).getAllByRole("button", { name: "Imposta all'istante attuale" })[0]!);
    expect(within(dialog).getByRole("textbox", { name: "Inizio" })).toHaveValue("12:30");
    await user.clear(within(dialog).getByRole("textbox", { name: "Fine" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Fine" }), "15:00");

    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Destinazione" }), pdf.id);
    const page = within(dialog).getByRole("spinbutton", { name: "Pagina (1–3)" });
    await user.clear(page);
    await user.type(page, "5");
    await user.click(create);
    expect(within(dialog).getByText("Scegli una pagina da 1 a 3.")).toBeInTheDocument();
    await user.clear(page);
    await user.type(page, "2");

    await user.click(within(dialog).getByRole("radio", { name: "Una regione" }));
    expect(await within(dialog).findByRole("img", { name: /slide\.pdf, pagina 2/ })).toBeInTheDocument();
    await user.type(within(dialog).getByRole("spinbutton", { name: "Da sinistra (%)" }), "10");
    await user.type(within(dialog).getByRole("spinbutton", { name: "Dall'alto (%)" }), "20");
    await user.type(within(dialog).getByRole("spinbutton", { name: "Larghezza (%)" }), "95");
    await user.type(within(dialog).getByRole("spinbutton", { name: "Altezza (%)" }), "40");
    await user.click(create);
    expect(within(dialog).getByText(/La regione deve avere larghezza e altezza maggiori di 0/)).toBeInTheDocument();
    expect(mockedApi.createMediaLink).not.toHaveBeenCalled();
    const width = within(dialog).getByRole("spinbutton", { name: "Larghezza (%)" });
    await user.clear(width);
    await user.type(width, "30");
    await user.type(within(dialog).getByRole("textbox", { name: /Nota/ }), "Teorema degli zeri");
    await user.click(create);

    expect(mockedApi.createMediaLink).toHaveBeenCalledWith({
      mediaVersionId: doc.current.id,
      startMs: 750_000,
      endMs: 900_000,
      targetVersionId: pdf.current.id,
      targetPage: 2,
      region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      note: "Teorema degli zeri",
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Nuovo collegamento" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: /^Apri slide\.pdf · p\. 2 · regione/ })).toBeInTheDocument();
  });

  it("draws a region by dragging on the page", async () => {
    const doc = transcribed();
    const pdf = slides();
    withLibrary({ documents: [doc, pdf] });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    await user.click(await screen.findByRole("button", { name: "Nuovo collegamento" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo collegamento" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Destinazione" }), pdf.id);
    await user.click(within(dialog).getByRole("radio", { name: "Una regione" }));
    const surface = await within(dialog).findByTestId("region-draw");
    surface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 400, right: 200, bottom: 400, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(surface, { button: 0, clientX: 20, clientY: 40, pointerId: 1 });
    fireEvent.pointerMove(surface, { clientX: 120, clientY: 240, pointerId: 1 });
    fireEvent.pointerUp(surface, { clientX: 120, clientY: 240, pointerId: 1 });
    expect(within(dialog).getByRole("spinbutton", { name: "Da sinistra (%)" })).toHaveValue(10);
    expect(within(dialog).getByRole("spinbutton", { name: "Dall'alto (%)" })).toHaveValue(10);
    expect(within(dialog).getByRole("spinbutton", { name: "Larghezza (%)" })).toHaveValue(50);
    expect(within(dialog).getByRole("spinbutton", { name: "Altezza (%)" })).toHaveValue(50);
  });

  it("creates a link from the selected transcript segments", async () => {
    const doc = transcribed();
    withLibrary({ documents: [doc, slides()] });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    await user.click(await screen.findByRole("button", { name: "Seleziona segmenti da collegare" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleziona il segmento delle 00:10" }));
    await user.click(screen.getByRole("checkbox", { name: "Seleziona il segmento delle 00:20" }));
    expect(screen.getByText("2 segmenti selezionati")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Collega la selezione" }));
    const dialog = screen.getByRole("dialog", { name: "Nuovo collegamento" });
    expect(within(dialog).getByRole("textbox", { name: "Inizio" })).toHaveValue("00:10");
    expect(within(dialog).getByRole("textbox", { name: "Fine" })).toHaveValue("00:30");
  });

  it("opens the target page with the region highlighted, and edits/deletes links with confirmation", async () => {
    const doc = transcribed();
    const pdf = slides();
    withLibrary({ documents: [doc, pdf] });
    const link = makeLink(doc, pdf, { region: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, note: "Grafico" });
    links = [link];
    mockedApi.deleteMediaLink.mockImplementation(async () => {
      links = [];
    });
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lezione\.mp3/ }));
    expect(await screen.findByRole("button", { name: /^Riproduci da 12:30/ })).toHaveTextContent("12:30–15:00");

    await user.click(screen.getByRole("button", { name: /^Elimina il collegamento 12:30–15:00/ }));
    const confirm = screen.getByRole("alertdialog", { name: "Eliminare il collegamento?" });
    await user.click(within(confirm).getByRole("button", { name: "Annulla" }));
    expect(mockedApi.deleteMediaLink).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /^Modifica il collegamento 12:30–15:00/ }));
    const edit = screen.getByRole("dialog", { name: "Modifica collegamento" });
    expect(within(edit).getByRole("spinbutton", { name: "Larghezza (%)" })).toHaveValue(30);
    await user.click(within(edit).getByRole("button", { name: "Annulla" }));

    await user.click(screen.getByRole("button", { name: /^Apri slide\.pdf · p\. 2 · regione/ }));
    expect(await screen.findByRole("heading", { name: "slide.pdf", level: 2 })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: /^Regione collegata: regione da sinistra 10 %/ })).toHaveStyle({
      left: "10%",
      top: "20%",
      width: "30%",
      height: "40%",
    });
    expect(screen.getByRole("textbox", { name: /^Pagina/ })).toHaveValue("2");
    expect(screen.getByRole("heading", { name: /Collegato a lezione\.mp3 · 12:30–15:00/ })).toBeInTheDocument();

    // Back to the recording at the start of the interval.
    await user.click(screen.getByRole("button", { name: "Ascolta da 12:30" }));
    expect(await screen.findByRole("heading", { name: "lezione.mp3", level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(currentTime()).toBe(750));

    await user.click(await screen.findByRole("button", { name: /^Elimina il collegamento 12:30–15:00/ }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Eliminare il collegamento?" })).getByRole("button", { name: "Elimina" }));
    expect(mockedApi.deleteMediaLink).toHaveBeenCalledWith(link.id);
    expect(await screen.findByText(/Nessun collegamento\./)).toBeInTheDocument();
  });

  it("shows backlinks in the PDF and image viewers that open the player at that time", async () => {
    const doc = transcribed();
    const photo = makeDocument("lavagna.png", { kind: "image" });
    withLibrary({ documents: [doc, photo] });
    backlinks = [makeLink(doc, photo, { startMs: 125_000, endMs: 190_000 })];
    const { user } = renderLibrary();
    await user.click(await screen.findByRole("button", { name: /^lavagna\.png/ }));
    expect(mockedApi.listLinksForTarget).toHaveBeenCalledWith(photo.current.id);
    const backlink = await screen.findByRole("button", { name: "Collegato a lezione.mp3 · 02:05–03:10" });
    await user.click(backlink);
    expect(await screen.findByRole("heading", { name: "lezione.mp3", level: 2 })).toBeInTheDocument();
    await waitFor(() => expect(currentTime()).toBe(125));
  });
});
