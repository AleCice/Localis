// The only module that talks to the backend. Components import from here.
// Owner: main agent.
import { invoke } from "@tauri-apps/api/core";
import type {
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
  TextUnit,
} from "./types";
import { toAppError } from "./types";
import { mockBackend } from "./mock";

export interface Api {
  listProjects(): Promise<Project[]>;
  createProject(input: NewProjectInput): Promise<Project>;
  /** Deletes the project, its folders, documents and Localis' own copies of the originals. Never touches the user's files. */
  deleteProject(id: string): Promise<void>;

  // v0.2 Library
  listFolders(projectId: string): Promise<Folder[]>;
  createFolder(input: NewFolderInput): Promise<Folder>;
  renameFolder(id: string, name: string): Promise<Folder>;
  /** Fails with `conflict` if the folder contains documents or subfolders. */
  deleteFolder(id: string): Promise<void>;

  listDocuments(projectId: string): Promise<LibraryDocument[]>;
  /** All versions of a document, newest first. */
  listVersions(documentId: string): Promise<DocumentVersion[]>;
  importDocument(bytes: Uint8Array, meta: ImportFileMeta): Promise<ImportResult>;
  /** Adds a new version; fails with `duplicate` if the bytes match an existing version of the document. */
  importVersion(documentId: string, bytes: Uint8Array, fileName: string, lastModified?: number | null): Promise<LibraryDocument>;
  moveDocument(id: string, folderId: string | null): Promise<LibraryDocument>;
  /** Deletes the document, all its versions, extracted text and Localis' copies (if not shared). */
  deleteDocument(id: string): Promise<void>;
  /** Bytes of the stored original, verified against its sha256 (`integrity` error otherwise). */
  readOriginal(versionId: string): Promise<ArrayBuffer>;
  getText(versionId: string): Promise<TextUnit[]>;
  search(projectId: string, query: string, limit?: number): Promise<SearchHit[]>;

  listJobs(projectId: string): Promise<Job[]>;
  /** Requeues a failed job. */
  retryJob(id: number): Promise<Job>;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type InvokeArgs = Record<string, unknown> | Uint8Array;

async function call<T>(cmd: string, args?: InvokeArgs, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) {
    throw {
      code: "internal",
      message: "Localis va avviato come app desktop.",
      detail: "Tauri runtime not detected (use `npm run tauri dev`, or `npm run dev:mock` for UI work).",
    };
  }
  try {
    return await invoke<T>(cmd, args, headers ? { headers } : undefined);
  } catch (err) {
    throw toAppError(err);
  }
}

const tauriApi: Api = {
  listProjects: () => call<Project[]>("list_projects"),
  createProject: (input) => call<Project>("create_project", { input }),
  deleteProject: (id) => call<void>("delete_project", { id }),

  listFolders: (projectId) => call<Folder[]>("list_folders", { projectId }),
  createFolder: (input) => call<Folder>("create_folder", { input }),
  renameFolder: (id, name) => call<Folder>("rename_folder", { id, name }),
  deleteFolder: (id) => call<void>("delete_folder", { id }),

  listDocuments: (projectId) => call<LibraryDocument[]>("list_documents", { projectId }),
  listVersions: (documentId) => call<DocumentVersion[]>("list_versions", { documentId }),
  // Raw IPC body: the webview sends the bytes of a file the user picked; the backend never
  // reads arbitrary paths. Metadata travels in headers (file name percent-encoded: ASCII only).
  importDocument: (bytes, meta) =>
    call<ImportResult>("import_document", bytes, {
      "x-project-id": meta.projectId,
      "x-folder-id": meta.folderId ?? "",
      "x-file-name": encodeURIComponent(meta.fileName),
      "x-last-modified": meta.lastModified != null ? String(meta.lastModified) : "",
    }),
  importVersion: (documentId, bytes, fileName, lastModified) =>
    call<LibraryDocument>("import_version", bytes, {
      "x-document-id": documentId,
      "x-file-name": encodeURIComponent(fileName),
      "x-last-modified": lastModified != null ? String(lastModified) : "",
    }),
  moveDocument: (id, folderId) => call<LibraryDocument>("move_document", { id, folderId }),
  deleteDocument: (id) => call<void>("delete_document", { id }),
  readOriginal: (versionId) => call<ArrayBuffer>("read_original", { versionId }),
  getText: (versionId) => call<TextUnit[]>("get_text", { versionId }),
  search: (projectId, query, limit) => call<SearchHit[]>("search", { input: { projectId, query, limit: limit ?? 50 } }),

  listJobs: (projectId) => call<Job[]>("list_jobs", { projectId }),
  retryJob: (id) => call<Job>("retry_job", { id }),
};

// The in-memory mock exists only for UI development and browser tests
// (`npm run dev:mock`); it is never used in the desktop app or production builds.
const useMock = import.meta.env.DEV && import.meta.env.VITE_API_MOCK === "1";

export const api: Api = useMock ? mockBackend : tauriApi;
