// Contract between the React frontend and the Tauri backend (v0.1 projects, v0.2 library).
// Owner: main agent. Mirrors the serde types in src-tauri/src/commands.rs.

export interface Project {
  id: string; // UUID v4
  name: string;
  description: string | null;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

export interface NewProjectInput {
  name: string;
  description?: string | null;
}

export type AppErrorCode =
  | "validation" // invalid input (field set when tied to a form field)
  | "duplicate" // name or content already present
  | "not_found" // record no longer exists
  | "conflict" // operation not allowed in the current state (e.g. folder not empty)
  | "unsupported" // file format not supported
  | "too_large" // file over the import size limit
  | "integrity" // stored original missing or not matching its hash
  | "storage"
  | "internal";

export interface AppError {
  code: AppErrorCode;
  /** Short, user-facing message in Italian. */
  message: string;
  /** Field concerned, when tied to an input: "name", "description", "file", "parentId", "folderId". */
  field?: string;
  /** Technical diagnostics: never shown in the normal UI, only in an expandable detail. */
  detail?: string;
}

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).code === "string" &&
    typeof (value as AppError).message === "string"
  );
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return {
    code: "internal",
    message: "Si è verificato un errore imprevisto.",
    detail: err instanceof Error ? err.message : String(err),
  };
}

// ---------------------------------------------------------------- v0.2 Library

/** Max size of a single imported file (bytes). Enforced by the backend. */
export const IMPORT_MAX_BYTES = 200 * 1024 * 1024;
export const FOLDER_NAME_MAX = 120;

/** Extensions accepted by the importer (lowercase, without dot). */
export const IMPORT_EXTENSIONS = ["pdf", "txt", "md", "markdown", "docx", "png", "jpg", "jpeg", "gif", "webp"] as const;

export interface Folder {
  id: string;
  projectId: string;
  parentId: string | null; // null = project root
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewFolderInput {
  projectId: string;
  parentId?: string | null;
  name: string;
}

export type DocumentKind = "pdf" | "text" | "markdown" | "docx" | "image";

/**
 * State of the searchable text of a version.
 * - pending: extraction queued or running
 * - extracted: text available and indexed for search
 * - no_text: format supports text but none was found (e.g. scanned PDF): viewable, not searchable
 * - failed: extraction failed (see the job for the error; can be retried)
 * - not_applicable: format without text extraction in this version (images)
 */
export type TextStatus = "pending" | "extracted" | "no_text" | "failed" | "not_applicable";

export interface DocumentVersion {
  id: string;
  documentId: string;
  versionNo: number; // 1-based
  originalName: string; // file name as imported
  kind: DocumentKind;
  mediaType: string; // e.g. "application/pdf", "image/png", "text/plain"
  sizeBytes: number;
  sha256: string; // hex of the original bytes
  sourceModifiedAt: string | null; // File.lastModified at import, ISO 8601 UTC
  importedAt: string;
  textStatus: TextStatus;
  pageCount: number | null; // PDF only
  imageWidth: number | null; // images only
  imageHeight: number | null;
}

/** A document = a sequence of versions of the same work; `current` is the latest. */
export interface LibraryDocument {
  id: string;
  projectId: string;
  folderId: string | null; // null = project root
  title: string; // original name of the first version (no extension stripping)
  createdAt: string;
  updatedAt: string;
  current: DocumentVersion;
  versionCount: number;
}

export interface ImportFileMeta {
  projectId: string;
  folderId?: string | null;
  fileName: string;
  lastModified?: number | null; // ms since epoch (File.lastModified)
}

export type ImportResult =
  | { status: "imported"; document: LibraryDocument }
  /** Same bytes (sha256) already present in this project: nothing was imported. */
  | { status: "duplicate"; document: LibraryDocument };

/** One unit of extracted text: a PDF page (1-based) or a text block/paragraph (1-based). */
export interface TextUnit {
  unit: number;
  text: string;
}

export type UnitKind = "page" | "block";

export interface SearchHit {
  documentId: string;
  versionId: string;
  title: string;
  folderId: string | null;
  unit: number;
  unitKind: UnitKind;
  /** Plain text excerpt; matched terms are wrapped in U+0002 (start) and U+0003 (end). */
  snippet: string;
}

export const SNIPPET_MARK_START = "\u0002";
export const SNIPPET_MARK_END = "\u0003";

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  documentId: string;
  versionId: string;
  kind: "extract_text";
  state: JobState;
  attempts: number;
  /** Italian, user-facing; only when failed. */
  error: string | null;
  /** Technical diagnostics; only when failed. */
  errorDetail: string | null;
  createdAt: string;
  updatedAt: string;
}
