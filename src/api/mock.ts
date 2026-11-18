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
import type {
  AppError,
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
};
