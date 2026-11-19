// In-memory backend for UI development and browser tests only (npm run dev:mock).
// Never part of the desktop app or production builds (see client.ts).
//
// Mirrors backend validation so the UI can be exercised without Tauri. Projects live in
// sessionStorage (a reload keeps them within the tab); library data (folders, documents,
// bytes, text, jobs) lives in memory only and is lost on reload.
//
// Honesty rules: extracted text always comes from the imported bytes. TXT/Markdown are
// split into blocks like the backend; PDF text is extracted in the browser with pdf.js
// (the desktop app uses its own Rust extractor, so results can differ); DOCX extraction
// is not implemented here and its jobs fail with an explicit "mock" detail.
//
// Chat (v0.3): LM Studio is never contacted. By default it is reported as not reachable, so
// answers end with `llm_unavailable` (inventory, clarification and no_evidence still work, like
// in the app). With VITE_MOCK_LLM=1 a fake model writes canned answers that say they come from
// the mock and cite the passages really found by the mock's lexical search. Retrieval here is
// always lexical: embedding progress is simulated and labelled as such, never used.
import type {
  AppError,
  ChatEvent,
  ChatMessage,
  Conversation,
  EmbeddingStatus,
  LlmSettings,
  LlmStatus,
  RetrievalInfo,
  SendMessageInput,
  Source,
  DocumentKind,
  DocumentVersion,
  Folder,
  ImportFileMeta,
  ImportResult,
  Job,
  LibraryDocument,
  NewFolderInput,
  NewProjectInput,
  Project,
  SearchHit,
  TextStatus,
  TextUnit,
} from "./types";
import {
  DESCRIPTION_MAX,
  FOLDER_NAME_MAX,
  IMPORT_MAX_BYTES,
  NAME_MAX,
  SNIPPET_MARK_END,
  SNIPPET_MARK_START,
} from "./types";
import type { Api } from "./client";

const KEY = "localis.mock.projects";

function load(): Project[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Project[];
  } catch {
    return [];
  }
}

function save(items: Project[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function fail(e: AppError): never {
  throw e;
}

const delay = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

// ------------------------------------------------------------------ library state

interface StoredDocument {
  id: string;
  projectId: string;
  folderId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const lib = {
  folders: [] as Folder[],
  documents: [] as StoredDocument[],
  versions: [] as DocumentVersion[],
  blobs: new Map<string, Uint8Array>(),
  text: new Map<string, TextUnit[]>(),
  jobs: [] as Job[],
  nextJobId: 1,
};

const collator = new Intl.Collator("it", { sensitivity: "base", numeric: true });

function projectExists(id: string) {
  if (!load().some((p) => p.id === id)) fail({ code: "not_found", message: "Il progetto non esiste più." });
}

function versionsOf(documentId: string): DocumentVersion[] {
  return lib.versions.filter((v) => v.documentId === documentId).sort((a, b) => b.versionNo - a.versionNo);
}

function toLibraryDocument(doc: StoredDocument): LibraryDocument {
  const versions = versionsOf(doc.id);
  return { ...doc, current: { ...versions[0]! }, versionCount: versions.length };
}

function findDocument(id: string): StoredDocument {
  return lib.documents.find((d) => d.id === id) ?? fail({ code: "not_found", message: "Il documento non esiste più." });
}

function validateFolderName(raw: string): string {
  const name = raw.trim();
  if (!name) fail({ code: "validation", field: "name", message: "Inserisci un nome." });
  if ([...name].length > FOLDER_NAME_MAX)
    fail({ code: "validation", field: "name", message: `Il nome può avere al massimo ${FOLDER_NAME_MAX} caratteri.` });
  if (/[\u0000-\u001f\u007f]/.test(name))
    fail({ code: "validation", field: "name", message: "Il nome contiene caratteri non ammessi." });
  return name;
}

function checkSiblingName(projectId: string, parentId: string | null, name: string, exceptId?: string) {
  const clash = lib.folders.some(
    (f) =>
      f.projectId === projectId &&
      f.parentId === parentId &&
      f.id !== exceptId &&
      f.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) fail({ code: "duplicate", field: "name", message: "Esiste già una cartella con questo nome." });
}

// ------------------------------------------------------------------ format sniffing

const EXT_KIND: Record<string, DocumentKind> = {
  pdf: "pdf",
  txt: "text",
  md: "markdown",
  markdown: "markdown",
  docx: "docx",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0) {
  return prefix.every((b, i) => bytes[offset + i] === b);
}

function ascii(s: string) {
  return [...s].map((c) => c.charCodeAt(0));
}

function containsAscii(bytes: Uint8Array, needle: string) {
  const n = ascii(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

function sniffImage(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function detect(fileName: string, bytes: Uint8Array): { kind: DocumentKind; mediaType: string } {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const kind = EXT_KIND[ext];
  const unsupported = (why: string): never => fail({ code: "unsupported", message: `Formato non supportato: ${why}` });
  if (!kind) return unsupported(ext ? `.${ext}` : "file senza estensione");
  switch (kind) {
    case "pdf":
      if (!startsWith(bytes, ascii("%PDF-"))) unsupported("il file .pdf non contiene un PDF valido.");
      return { kind, mediaType: "application/pdf" };
    case "docx":
      if (!startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || !containsAscii(bytes, "word/document.xml"))
        unsupported("il file .docx non è un documento Word valido.");
      return { kind, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    case "image": {
      const mediaType = sniffImage(bytes);
      if (!mediaType) return unsupported(`il file .${ext} non è un'immagine riconosciuta.`);
      return { kind, mediaType };
    }
    case "text":
    case "markdown":
      if (decodeUtf8(bytes) === null) unsupported("il testo non è codificato in UTF-8.");
      return { kind, mediaType: kind === "text" ? "text/plain" : "text/markdown" };
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ extraction jobs

class MockExtractionUnavailable extends Error {}

function textBlocks(text: string): TextUnit[] {
  return text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim() !== "")
    .map((text, i) => ({ unit: i + 1, text }));
}

async function pdfPages(bytes: Uint8Array): Promise<{ pageCount: number; units: TextUnit[] }> {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: bytes.slice(), useWorkerFetch: false, useWasm: false, enableXfa: false });
  try {
    const doc = await task.promise;
    const units: TextUnit[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      if (text.trim()) units.push({ unit: n, text: text.trim() });
    }
    return { pageCount: doc.numPages, units };
  } finally {
    void task.destroy();
  }
}

async function extract(version: DocumentVersion, bytes: Uint8Array): Promise<TextUnit[]> {
  switch (version.kind) {
    case "text":
    case "markdown":
      return textBlocks(decodeUtf8(bytes) ?? "");
    case "pdf": {
      const { pageCount, units } = await pdfPages(bytes);
      version.pageCount = pageCount;
      return units;
    }
    case "docx":
      throw new MockExtractionUnavailable(
        "mock backend: DOCX text extraction is not implemented (the desktop app does it)",
      );
    case "image":
      return [];
  }
}

function setStatus(versionId: string, status: TextStatus) {
  const v = lib.versions.find((x) => x.id === versionId);
  if (v) v.textStatus = status;
}

function runJob(jobId: number) {
  const touch = (job: Job, patch: Partial<Job>) => Object.assign(job, patch, { updatedAt: now() });
  setTimeout(() => {
    const job = lib.jobs.find((j) => j.id === jobId);
    if (!job || job.state !== "queued") return;
    touch(job, { state: "running", attempts: job.attempts + 1 });
    setTimeout(async () => {
      const version = lib.versions.find((v) => v.id === job.versionId);
      if (!version || !lib.jobs.includes(job)) return;
      try {
        const units = await extract(version, lib.blobs.get(version.sha256) ?? new Uint8Array());
        if (!lib.jobs.includes(job)) return;
        lib.text.set(version.id, units);
        setStatus(version.id, units.length > 0 ? "extracted" : "no_text");
        touch(job, { state: "done", error: null, errorDetail: null });
      } catch (err) {
        if (!lib.jobs.includes(job)) return;
        lib.text.delete(version.id);
        setStatus(version.id, "failed");
        touch(job, {
          state: "failed",
          error:
            err instanceof MockExtractionUnavailable
              ? "Estrazione del testo non disponibile nel backend di prova."
              : "Non è stato possibile estrarre il testo.",
          errorDetail: err instanceof Error ? err.message : String(err),
        });
      }
    }, 800);
  }, 400);
}

function enqueue(version: DocumentVersion) {
  if (version.kind === "image") return;
  const stamp = now();
  const job: Job = {
    id: lib.nextJobId++,
    documentId: version.documentId,
    versionId: version.id,
    kind: "extract_text",
    state: "queued",
    attempts: 0,
    error: null,
    errorDetail: null,
    createdAt: stamp,
    updatedAt: stamp,
  };
  lib.jobs.push(job);
  runJob(job.id);
}

async function imageSize(bytes: Uint8Array, mediaType: string): Promise<{ w: number | null; h: number | null }> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mediaType }));
    const size = { w: bitmap.width, h: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { w: null, h: null };
  }
}

async function newVersion(
  documentId: string,
  versionNo: number,
  fileName: string,
  lastModified: number | null | undefined,
  bytes: Uint8Array,
  kind: DocumentKind,
  mediaType: string,
  sha256: string,
): Promise<DocumentVersion> {
  const size = kind === "image" ? await imageSize(bytes, mediaType) : { w: null, h: null };
  const version: DocumentVersion = {
    id: crypto.randomUUID(),
    documentId,
    versionNo,
    originalName: fileName,
    kind,
    mediaType,
    sizeBytes: bytes.byteLength,
    sha256,
    sourceModifiedAt: lastModified ? new Date(lastModified).toISOString() : null,
    importedAt: now(),
    textStatus: kind === "image" ? "not_applicable" : "pending",
    pageCount: null,
    imageWidth: size.w,
    imageHeight: size.h,
  };
  lib.blobs.set(sha256, bytes.slice());
  lib.versions.push(version);
  enqueue(version);
  return version;
}

function checkBytes(bytes: Uint8Array) {
  if (bytes.byteLength === 0) fail({ code: "validation", message: "Il file è vuoto." });
  if (bytes.byteLength > IMPORT_MAX_BYTES) fail({ code: "too_large", message: "Il file supera il limite di 200 MB." });
}

function gcBlobs() {
  const used = new Set(lib.versions.map((v) => v.sha256));
  for (const sha of lib.blobs.keys()) if (!used.has(sha)) lib.blobs.delete(sha);
}

function removeDocuments(ids: Set<string>) {
  const versionIds = new Set(lib.versions.filter((v) => ids.has(v.documentId)).map((v) => v.id));
  lib.documents = lib.documents.filter((d) => !ids.has(d.id));
  lib.versions = lib.versions.filter((v) => !versionIds.has(v.id));
  lib.jobs = lib.jobs.filter((j) => !versionIds.has(j.versionId));
  for (const id of versionIds) lib.text.delete(id);
  gcBlobs();
}

// ------------------------------------------------------------------ search

function normalize(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const WORD = /[\p{L}\p{N}]+/gu;

function searchUnit(text: string, terms: string[]): string | null {
  const words = [...text.matchAll(WORD)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
    norm: normalize(m[0]),
  }));
  const matches = (w: { norm: string }, i: number) =>
    i === terms.length - 1 ? w.norm.startsWith(terms[i]!) : w.norm === terms[i];
  const isHit = (w: { norm: string }) => terms.some((_, i) => matches(w, i));
  if (!terms.every((_, i) => words.some((w) => matches(w, i)))) return null;
  const first = words.findIndex(isHit);
  const from = Math.max(0, first - 5);
  const to = Math.min(words.length, from + 14);
  let out = from > 0 ? "…" : "";
  let cursor = words[from]!.start;
  for (let i = from; i < to; i++) {
    const w = words[i]!;
    out += text.slice(cursor, w.start).replace(/\s+/g, " ");
    const word = text.slice(w.start, w.end);
    out += isHit(w) ? `${SNIPPET_MARK_START}${word}${SNIPPET_MARK_END}` : word;
    cursor = w.end;
  }
  if (to < words.length) out += "…";
  return out;
}

// ------------------------------------------------------------------ chat (v0.3)

const MOCK_LLM = import.meta.env.VITE_MOCK_LLM === "1";
const MOCK_CHAT_MODEL = "backend-di-prova/chat-finto";
const MOCK_EMBEDDING_MODEL = "backend-di-prova/embedding-finto";
const MOCK_DETAIL =
  "backend di prova (npm run dev:mock): LM Studio non viene contattato. Con VITE_MOCK_LLM=1 un modello finto produce risposte di prova.";

const chat = {
  settings: { baseUrl: "http://127.0.0.1:1234", chatModel: null, embeddingModel: null } as LlmSettings,
  conversations: [] as Conversation[],
  messages: [] as ChatMessage[],
  generating: new Set<string>(),
  cancelled: new Set<string>(),
  /** Simulated embedding progress: start time per project + model. */
  embeddingStart: new Map<string, number>(),
};

function validateBaseUrl(raw: string): string {
  const invalid = (): never =>
    fail({
      code: "validation",
      field: "baseUrl",
      message: "Usa un indirizzo http di questo computer, ad esempio http://127.0.0.1:1234.",
    });
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return invalid();
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) invalid();
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) invalid();
  return `${url.protocol}//${url.host}`;
}

interface Chunk {
  documentId: string;
  versionId: string;
  title: string;
  unit: number;
  unitKind: "page" | "block";
  text: string;
}

/** Splits a unit into passages of at most ~1200 characters on paragraph/sentence/word boundaries. */
function splitPassages(text: string, max = 1200): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
    if (cut < max * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function projectChunks(projectId: string, documentIds?: Set<string>): Chunk[] {
  const chunks: Chunk[] = [];
  for (const doc of lib.documents.filter((d) => d.projectId === projectId)) {
    if (documentIds && !documentIds.has(doc.id)) continue;
    const current = versionsOf(doc.id)[0]!;
    for (const unit of lib.text.get(current.id) ?? []) {
      for (const text of splitPassages(unit.text)) {
        chunks.push({
          documentId: doc.id,
          versionId: current.id,
          title: doc.title,
          unit: unit.unit,
          unitKind: current.kind === "pdf" ? "page" : "block",
          text,
        });
      }
    }
  }
  return chunks;
}

const STOPWORDS = new Set(
  (
    "il lo la i gli le un uno una di a da in con su per tra fra e o ma se che chi cosa come dove quando quale quali " +
    "del dello della dei degli delle al allo alla ai agli alle dal dallo dalla dai dagli dalle nel nello nella nei " +
    "negli nelle sul sullo sulla sui sugli sulle è sono mi ti si ci vi ne non piu più anche questo questa questi " +
    "queste quello quella quelli quelle mio tuo suo nostro loro dimmi spiega spiegami parla documento documenti file"
  ).split(" "),
);

function questionTerms(question: string): string[] {
  const words = normalize(question).match(WORD) ?? [];
  return [...new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w)))];
}

function chunkScore(text: string, terms: string[]): number {
  const words = (normalize(text).match(WORD) ?? []) as string[];
  let score = 0;
  for (const term of terms) {
    if (words.some((w) => (term.length >= 4 ? w.startsWith(term) : w === term))) score += 1;
  }
  return score;
}

function titleWords(title: string): string[] {
  const base = title.replace(/\.[a-z0-9]{1,5}$/i, "");
  return normalize(base).match(WORD) ?? [];
}

/** Documents the question names reliably (whole title as a word sequence, or all significant words). */
function documentsNamed(projectId: string, question: string): StoredDocument[] {
  const q = ` ${(normalize(question).match(WORD) ?? []).join(" ")} `;
  const qWords = new Set(q.trim().split(" "));
  return lib.documents.filter((doc) => {
    if (doc.projectId !== projectId) return false;
    const words = titleWords(doc.title);
    if (words.length === 0) return false;
    if (q.includes(` ${words.join(" ")} `)) return true;
    const significant = words.filter((w) => w.length >= 3);
    return significant.length >= 2 && significant.every((w) => qWords.has(w));
  });
}

const INVENTORY = /\b(quali|che|elenca|elenco|lista|mostrami)\b.*\b(documenti|file|materiali)\b|\bcosa ho caricato\b/;
const DEICTIC = /\b(questo|quel|quello|il)\s+(documento|file|pdf|testo)\b/;

function citedNumbers(content: string): Set<number> {
  const prose = content.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
  const found = new Set<number>();
  for (const m of prose.matchAll(/\[(\d+(?:\s*[,;]\s*\d+)*|\d+\s*[-–]\s*\d+)\]/g)) {
    const parts = m[1]!.split(/\s*[,;\-–]\s*/).map(Number);
    if (/[-–]/.test(m[1]!) && parts.length === 2) for (let n = parts[0]!; n <= parts[1]!; n++) found.add(n);
    else parts.forEach((n) => found.add(n));
  }
  return found;
}

function excerptOf(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}

function cannedAnswer(question: string, evidence: Source[]): string {
  const head =
    "**Risposta di prova del backend finto: non è stata generata da un modello.** " +
    "Riporta i passaggi trovati dalla ricerca lessicale del backend di prova.";
  if (question.trim().startsWith("/demo")) {
    return [
      head,
      "",
      "Contenuto dimostrativo per verificare la resa di Markdown e formule (non viene dai documenti):",
      "",
      `Inline \\(e^{i\\pi} + 1 = 0\\) e $a^2 + b^2 = c^2$; primo passaggio trovato [1].`,
      "",
      "\\[",
      "\\int_0^1 f(x)\\,dx = \\lim_{n\\to\\infty} \\sum_{k=1}^{n} f\\left(\\tfrac{k}{n}\\right)\\tfrac{1}{n} + \\sum_{k=1}^{n} \\binom{n}{k} x^k (1-x)^{n-k} + \\sum_{j=1}^{m} \\frac{\\partial^2 u}{\\partial x_j^2} + \\Gamma(z) = \\int_0^\\infty t^{z-1} e^{-t}\\,dt",
      "\\]",
      "",
      "$$",
      "\\begin{pmatrix} a & b \\\\[2pt] c & d \\end{pmatrix}",
      "$$",
      "",
      "| Colonna 1 | Colonna 2 | Colonna 3 | Colonna 4 | Colonna 5 | Colonna 6 | Colonna 7 | Colonna 8 |",
      "|---|---|---|---|---|---|---|---|",
      "| valore molto lungo uno | valore molto lungo due | valore molto lungo tre | valore molto lungo quattro | cinque | sei | sette | otto |",
      "",
      "```python",
      "def esempio(x):  # \\(non convertito\\) e $nemmeno$ qui [1]",
      "    return [x ** 2 for x in range(100) if x % 3 == 0 and x % 5 == 0 and x % 7 == 0 and x % 11 == 0]",
      "```",
      "",
      "Codice inline `\\(x\\)` e `$y$` restano letterali. Link: [esempio](https://example.com). Riferimento inesistente: [99].",
    ].join("\n");
  }
  const lines = evidence.slice(0, 3).map((s) => `- «${excerptOf(s.text)}» [${s.n}]`);
  return [head, "", ...lines, "", "Un riferimento a una fonte inesistente resta testo semplice: [99]."].join("\n");
}

function storeMessage(message: ChatMessage) {
  const at = chat.messages.findIndex((m) => m.id === message.id);
  if (at >= 0) chat.messages[at] = message;
  else chat.messages.push(message);
}

function withAvailability(message: ChatMessage): ChatMessage {
  return {
    ...message,
    sources: message.sources.map((s) => ({
      ...s,
      available: lib.versions.some((v) => v.id === s.versionId && v.documentId === s.documentId),
    })),
  };
}

async function runChat(input: SendMessageInput, onEvent: (event: ChatEvent) => void): Promise<ChatMessage> {
  await delay(80);
  const conversation =
    chat.conversations.find((c) => c.id === input.conversationId) ??
    fail({ code: "not_found", message: "La conversazione non esiste più." });
  const question = input.text.trim();
  if (!question) fail({ code: "validation", field: "text", message: "Scrivi una domanda." });
  if (chat.generating.has(conversation.id))
    fail({ code: "conflict", message: "È già in corso una risposta in questa conversazione." });

  const stamp = now();
  const base = { conversationId: conversation.id, error: null, model: null, retrieval: null, sources: [], candidates: [] };
  const userMessage: ChatMessage = { ...base, id: crypto.randomUUID(), role: "user", kind: "question", content: question, status: "complete", createdAt: stamp };
  const previous = chat.messages.filter((m) => m.conversationId === conversation.id);
  storeMessage(userMessage);
  if (conversation.title === "Nuova conversazione") conversation.title = question.length > 60 ? `${question.slice(0, 60).trimEnd()}…` : question;
  conversation.updatedAt = stamp;

  let assistant: ChatMessage = { ...base, id: crypto.randomUUID(), role: "assistant", kind: "answer", content: "", status: "streaming", createdAt: now() };
  storeMessage(assistant);
  chat.generating.add(conversation.id);
  onEvent({ type: "accepted", userMessage: { ...userMessage }, assistantMessageId: assistant.id });

  const complete = (patch: Partial<ChatMessage>): ChatMessage => {
    assistant = { ...assistant, status: "complete", ...patch };
    storeMessage(assistant);
    chat.generating.delete(conversation.id);
    chat.cancelled.delete(conversation.id);
    return withAvailability(assistant);
  };

  try {
    await delay(150);
    onEvent({ type: "phase", phase: "retrieving" });
    const projectId = conversation.projectId;
    const projectDocs = lib.documents.filter((d) => d.projectId === projectId);
    const normQuestion = (normalize(question).match(WORD) ?? []).join(" ");

    // Inventory: built by Localis from the library, no model.
    if (!input.documentIds?.length && INVENTORY.test(normQuestion)) {
      const lines = projectDocs
        .sort((a, b) => collator.compare(a.title, b.title))
        .map((d) => {
          const v = versionsOf(d.id)[0]!;
          const folder = d.folderId ? (lib.folders.find((f) => f.id === d.folderId)?.name ?? "") : "cartella principale";
          const status =
            v.textStatus === "extracted" ? "" : v.textStatus === "no_text" ? " · senza testo ricercabile" : v.textStatus === "not_applicable" ? " · immagine, non ricercabile" : v.textStatus === "pending" ? " · estrazione in corso" : " · estrazione non riuscita";
          return `- **${d.title}** · ${v.kind.toUpperCase()} · ${folder}${status}`;
        });
      const content =
        lines.length === 0
          ? "Il progetto non contiene documenti."
          : `Il progetto contiene ${lines.length === 1 ? "1 documento" : `${lines.length} documenti`}:\n\n${lines.join("\n")}`;
      const final = complete({ kind: "inventory", content });
      onEvent({ type: "done", message: final });
      return final;
    }

    // Scope.
    let scope: RetrievalInfo["scope"] = "project";
    let scopeReason: RetrievalInfo["scopeReason"] = null;
    let documentIds: string[] = [];
    if (input.documentIds?.length) {
      scope = "documents";
      scopeReason = "selection";
      documentIds = input.documentIds.filter((id) => projectDocs.some((d) => d.id === id));
    } else {
      const named = documentsNamed(projectId, question);
      if (named.length > 1) {
        const final = complete({
          kind: "clarification",
          content: "La domanda può riferirsi a più documenti. Quale intendi?",
          candidates: named.map((d) => ({ documentId: d.id, title: d.title })),
        });
        onEvent({ type: "done", message: final });
        return final;
      }
      if (named.length === 1) {
        scope = "documents";
        scopeReason = "title";
        documentIds = [named[0]!.id];
      } else if (DEICTIC.test(normQuestion)) {
        const last = [...previous].reverse().find((m) => m.role === "assistant" && m.retrieval);
        if (last?.retrieval?.scope === "documents" && last.retrieval.documentIds.length === 1) {
          scope = "documents";
          scopeReason = "history";
          documentIds = [...last.retrieval.documentIds];
        } else {
          const recent = [...new Set(previous.flatMap((m) => m.sources.filter((s) => s.cited).map((s) => s.documentId)))];
          const candidates = (recent.length > 0 ? projectDocs.filter((d) => recent.includes(d.id)) : projectDocs.length <= 6 ? projectDocs : []).map((d) => ({ documentId: d.id, title: d.title }));
          const final = complete({ kind: "clarification", content: "A quale documento ti riferisci?", candidates });
          onEvent({ type: "done", message: final });
          return final;
        }
      }
    }

    // Lexical retrieval over passages of current versions.
    const terms = questionTerms(question);
    const query = terms.map((t) => (t.length >= 4 ? `"${t}"*` : `"${t}"`)).join(" OR ");
    const chunks = projectChunks(projectId, scope === "documents" ? new Set(documentIds) : undefined);
    const ranked = chunks
      .map((c) => ({ c, score: chunkScore(c.text, terms) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30);
    const sources: Source[] = ranked.map(({ c }, i) => ({
      rank: i + 1,
      n: null,
      cited: false,
      documentId: c.documentId,
      versionId: c.versionId,
      title: c.title,
      unit: c.unit,
      unitKind: c.unitKind,
      text: c.text,
      via: "lexical",
      available: true,
    }));
    let budget = 6000;
    let n = 0;
    for (const s of sources) {
      if (n >= 8 || s.text.length > budget) continue;
      n += 1;
      s.n = n;
      budget -= s.text.length;
    }
    const retrieval: RetrievalInfo = { mode: "lexical", scope, documentIds, scopeReason, embeddingModel: null, query };

    if (sources.length === 0) {
      const scoped = scope === "documents" ? projectDocs.filter((d) => documentIds.includes(d.id)) : projectDocs;
      const withoutText = scoped.some((d) => ["no_text", "not_applicable"].includes(versionsOf(d.id)[0]!.textStatus));
      const final = complete({
        kind: "no_evidence",
        retrieval,
        content:
          "Non ho trovato nei documenti di questo progetto passaggi pertinenti." +
          (withoutText ? " Alcuni documenti non hanno testo ricercabile." : ""),
      });
      onEvent({ type: "done", message: final });
      return final;
    }

    const model = chat.settings.chatModel;
    if (!MOCK_LLM || !model) {
      const error: AppError = MOCK_LLM
        ? { code: "llm_unavailable", message: "Nessun modello di chat selezionato.", detail: MOCK_DETAIL }
        : { code: "llm_unavailable", message: `LM Studio non è raggiungibile su ${chat.settings.baseUrl}.`, detail: MOCK_DETAIL };
      const final = complete({ status: "error", error, retrieval, sources });
      onEvent({ type: "error", error, message: final });
      return final;
    }

    onEvent({ type: "phase", phase: "generating" });
    await delay(400);
    const text = cannedAnswer(question, sources.filter((s) => s.n != null));
    const pieces = text.match(/\S+\s*|\s+/g) ?? [];
    let content = "";
    for (const piece of pieces) {
      if (chat.cancelled.has(conversation.id)) {
        const error: AppError = { code: "cancelled", message: "Risposta interrotta." };
        const final = complete({ status: "cancelled", error, content, retrieval, sources, model });
        onEvent({ type: "error", error, message: final });
        return final;
      }
      content += piece;
      onEvent({ type: "delta", text: piece });
      await delay(35);
    }
    const valid = citedNumbers(content);
    const final = complete({
      content,
      retrieval,
      model,
      sources: sources.map((s) => ({ ...s, cited: s.n != null && valid.has(s.n) })),
    });
    onEvent({ type: "done", message: final });
    return final;
  } finally {
    chat.generating.delete(conversation.id);
    chat.cancelled.delete(conversation.id);
  }
}

// ------------------------------------------------------------------ API

export const mockBackend: Api = {
  async listProjects() {
    await delay();
    return load().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async createProject(input: NewProjectInput) {
    await delay();
    const name = input.name.trim();
    const description = input.description?.trim() || null;
    if (!name) fail({ code: "validation", field: "name", message: "Inserisci un nome." });
    if ([...name].length > NAME_MAX)
      fail({ code: "validation", field: "name", message: `Il nome può avere al massimo ${NAME_MAX} caratteri.` });
    if (description && [...description].length > DESCRIPTION_MAX)
      fail({
        code: "validation",
        field: "description",
        message: `La descrizione può avere al massimo ${DESCRIPTION_MAX} caratteri.`,
      });
    const items = load();
    if (items.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      fail({ code: "duplicate", field: "name", message: "Esiste già un progetto con questo nome." });
    const stamp = now();
    const project: Project = { id: crypto.randomUUID(), name, description, createdAt: stamp, updatedAt: stamp };
    save([project, ...items]);
    return project;
  },
  async deleteProject(id: string) {
    await delay();
    const items = load();
    if (!items.some((p) => p.id === id)) fail({ code: "not_found", message: "Il progetto non esiste più." });
    save(items.filter((p) => p.id !== id));
    removeDocuments(new Set(lib.documents.filter((d) => d.projectId === id).map((d) => d.id)));
    lib.folders = lib.folders.filter((f) => f.projectId !== id);
    const conversations = new Set(chat.conversations.filter((c) => c.projectId === id).map((c) => c.id));
    chat.conversations = chat.conversations.filter((c) => !conversations.has(c.id));
    chat.messages = chat.messages.filter((m) => !conversations.has(m.conversationId));
  },

  async listFolders(projectId) {
    await delay(60);
    return lib.folders
      .filter((f) => f.projectId === projectId)
      .sort((a, b) => collator.compare(a.name, b.name))
      .map((f) => ({ ...f }));
  },
  async createFolder(input: NewFolderInput) {
    await delay();
    projectExists(input.projectId);
    const name = validateFolderName(input.name);
    const parentId = input.parentId ?? null;
    if (parentId && !lib.folders.some((f) => f.id === parentId && f.projectId === input.projectId))
      fail({ code: "not_found", message: "La cartella non esiste più." });
    checkSiblingName(input.projectId, parentId, name);
    const stamp = now();
    const folder: Folder = {
      id: crypto.randomUUID(),
      projectId: input.projectId,
      parentId,
      name,
      createdAt: stamp,
      updatedAt: stamp,
    };
    lib.folders.push(folder);
    return { ...folder };
  },
  async renameFolder(id, rawName) {
    await delay();
    const folder =
      lib.folders.find((f) => f.id === id) ?? fail({ code: "not_found", message: "La cartella non esiste più." });
    const name = validateFolderName(rawName);
    checkSiblingName(folder.projectId, folder.parentId, name, folder.id);
    folder.name = name;
    folder.updatedAt = now();
    return { ...folder };
  },
  async deleteFolder(id) {
    await delay();
    if (!lib.folders.some((f) => f.id === id)) fail({ code: "not_found", message: "La cartella non esiste più." });
    if (lib.folders.some((f) => f.parentId === id) || lib.documents.some((d) => d.folderId === id))
      fail({ code: "conflict", message: "La cartella non è vuota." });
    lib.folders = lib.folders.filter((f) => f.id !== id);
  },

  async listDocuments(projectId) {
    await delay(60);
    return lib.documents
      .filter((d) => d.projectId === projectId)
      .sort((a, b) => collator.compare(a.title, b.title))
      .map(toLibraryDocument);
  },
  async listVersions(documentId) {
    await delay(60);
    findDocument(documentId);
    return versionsOf(documentId).map((v) => ({ ...v }));
  },
  async importDocument(bytes: Uint8Array, meta: ImportFileMeta): Promise<ImportResult> {
    await delay();
    projectExists(meta.projectId);
    const folderId = meta.folderId ?? null;
    if (folderId && !lib.folders.some((f) => f.id === folderId && f.projectId === meta.projectId))
      fail({ code: "not_found", message: "La cartella non esiste più." });
    checkBytes(bytes);
    const { kind, mediaType } = detect(meta.fileName, bytes);
    const sha256 = await sha256Hex(bytes);
    const existing = lib.versions.find(
      (v) => v.sha256 === sha256 && findDocument(v.documentId).projectId === meta.projectId,
    );
    if (existing) return { status: "duplicate", document: toLibraryDocument(findDocument(existing.documentId)) };
    const stamp = now();
    const doc: StoredDocument = {
      id: crypto.randomUUID(),
      projectId: meta.projectId,
      folderId,
      title: meta.fileName,
      createdAt: stamp,
      updatedAt: stamp,
    };
    lib.documents.push(doc);
    await newVersion(doc.id, 1, meta.fileName, meta.lastModified, bytes, kind, mediaType, sha256);
    return { status: "imported", document: toLibraryDocument(doc) };
  },
  async importVersion(documentId, bytes, fileName, lastModified) {
    await delay();
    const doc = findDocument(documentId);
    checkBytes(bytes);
    const { kind, mediaType } = detect(fileName, bytes);
    const versions = versionsOf(documentId);
    if (kind !== versions[0]!.kind)
      fail({ code: "validation", message: "La nuova versione deve essere dello stesso formato." });
    const sha256 = await sha256Hex(bytes);
    if (versions.some((v) => v.sha256 === sha256))
      fail({ code: "duplicate", message: "Questa versione è già presente nel documento." });
    await newVersion(doc.id, versions[0]!.versionNo + 1, fileName, lastModified, bytes, kind, mediaType, sha256);
    doc.updatedAt = now();
    return toLibraryDocument(doc);
  },
  async moveDocument(id, folderId) {
    await delay();
    const doc = findDocument(id);
    if (folderId && !lib.folders.some((f) => f.id === folderId && f.projectId === doc.projectId))
      fail({ code: "not_found", message: "La cartella non esiste più." });
    doc.folderId = folderId;
    doc.updatedAt = now();
    return toLibraryDocument(doc);
  },
  async deleteDocument(id) {
    await delay();
    findDocument(id);
    removeDocuments(new Set([id]));
  },
  async readOriginal(versionId) {
    await delay(60);
    const version =
      lib.versions.find((v) => v.id === versionId) ??
      fail({ code: "not_found", message: "La versione non esiste più." });
    const bytes = lib.blobs.get(version.sha256);
    if (!bytes) fail({ code: "integrity", message: "Il file originale non si trova nell'archivio di Localis." });
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
  },
  async getText(versionId) {
    await delay(60);
    if (!lib.versions.some((v) => v.id === versionId))
      fail({ code: "not_found", message: "La versione non esiste più." });
    return (lib.text.get(versionId) ?? []).map((u) => ({ ...u }));
  },
  async search(projectId, query, limit = 50) {
    await delay(80);
    const terms = (normalize(query).match(WORD) ?? []).filter(Boolean);
    if (terms.length === 0) return [];
    const hits: (SearchHit & { score: number })[] = [];
    for (const doc of lib.documents.filter((d) => d.projectId === projectId)) {
      const current = versionsOf(doc.id)[0]!;
      for (const unit of lib.text.get(current.id) ?? []) {
        const snippet = searchUnit(unit.text, terms);
        if (snippet === null) continue;
        const score = (snippet.match(new RegExp(SNIPPET_MARK_START, "g")) ?? []).length;
        hits.push({
          documentId: doc.id,
          versionId: current.id,
          title: doc.title,
          folderId: doc.folderId,
          unit: unit.unit,
          unitKind: current.kind === "pdf" ? "page" : "block",
          snippet,
          score,
        });
      }
    }
    return hits
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map(({ score: _score, ...hit }) => hit);
  },

  async listJobs(projectId) {
    await delay(60);
    const docs = new Set(lib.documents.filter((d) => d.projectId === projectId).map((d) => d.id));
    return lib.jobs
      .filter((j) => docs.has(j.documentId))
      .sort((a, b) => b.id - a.id)
      .slice(0, 200)
      .map((j) => ({ ...j }));
  },
  async retryJob(id) {
    await delay();
    const job =
      lib.jobs.find((j) => j.id === id) ?? fail({ code: "not_found", message: "L'operazione non esiste più." });
    if (job.state !== "failed") fail({ code: "conflict", message: "L'estrazione non è in errore." });
    Object.assign(job, { state: "queued", error: null, errorDetail: null, updatedAt: now() });
    setStatus(job.versionId, "pending");
    runJob(job.id);
    return { ...job };
  },

  async getLlmSettings() {
    await delay(40);
    return { ...chat.settings };
  },
  async setLlmSettings(settings) {
    await delay();
    const baseUrl = validateBaseUrl(settings.baseUrl);
    const chatModel = settings.chatModel?.trim() || null;
    const embeddingModel = settings.embeddingModel?.trim() || null;
    chat.settings = { baseUrl, chatModel, embeddingModel };
    return { ...chat.settings };
  },
  async getLlmStatus(): Promise<LlmStatus> {
    await delay(300);
    if (!MOCK_LLM)
      return { reachable: false, message: `LM Studio non risponde su ${chat.settings.baseUrl}.`, detail: MOCK_DETAIL, models: [] };
    return {
      reachable: true,
      message: null,
      detail: null,
      models: [
        { id: MOCK_CHAT_MODEL, kind: "llm", state: "loaded" },
        { id: MOCK_EMBEDDING_MODEL, kind: "embedding", state: "loaded" },
      ],
    };
  },
  async getEmbeddingStatus(projectId): Promise<EmbeddingStatus> {
    await delay(60);
    projectExists(projectId);
    const total = projectChunks(projectId).length;
    const model = chat.settings.embeddingModel;
    if (!model) return { state: "disabled", model: null, total, embedded: 0, message: null };
    if (!MOCK_LLM)
      return {
        state: "unreachable",
        model,
        total,
        embedded: 0,
        message: "LM Studio non è raggiungibile: l'indicizzazione riprenderà quando risponde.",
      };
    const key = `${projectId}|${model}`;
    if (!chat.embeddingStart.has(key)) chat.embeddingStart.set(key, Date.now());
    const embedded = Math.min(total, Math.floor((Date.now() - chat.embeddingStart.get(key)!) / 400));
    return {
      state: embedded < total ? "running" : "idle",
      model,
      total,
      embedded,
      message: "Backend di prova: avanzamento simulato, nessun embedding viene calcolato o usato.",
    };
  },

  async listConversations(projectId) {
    await delay(60);
    return chat.conversations
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({ ...c }));
  },
  async createConversation(projectId) {
    await delay();
    projectExists(projectId);
    const stamp = now();
    const conversation: Conversation = { id: crypto.randomUUID(), projectId, title: "Nuova conversazione", createdAt: stamp, updatedAt: stamp };
    chat.conversations.push(conversation);
    return { ...conversation };
  },
  async deleteConversation(id) {
    await delay();
    if (!chat.conversations.some((c) => c.id === id)) fail({ code: "not_found", message: "La conversazione non esiste più." });
    chat.cancelled.add(id);
    chat.conversations = chat.conversations.filter((c) => c.id !== id);
    chat.messages = chat.messages.filter((m) => m.conversationId !== id);
  },
  async listMessages(conversationId) {
    await delay(60);
    if (!chat.conversations.some((c) => c.id === conversationId))
      fail({ code: "not_found", message: "La conversazione non esiste più." });
    return chat.messages.filter((m) => m.conversationId === conversationId).map(withAvailability);
  },
  sendMessage: runChat,
  async cancelGeneration(conversationId) {
    await delay(40);
    if (chat.generating.has(conversationId)) chat.cancelled.add(conversationId);
  },
};
