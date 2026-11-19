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
  | "llm_unavailable" // LM Studio not reachable, no model selected or the model failed
  | "cancelled" // generation stopped by the user
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

// ---------------------------------------------------------------- v0.3 Local chat with sources

/** LM Studio connection. Only loopback http URLs are accepted (no remote hosts before 0.6). */
export interface LlmSettings {
  baseUrl: string; // default "http://127.0.0.1:1234"
  chatModel: string | null; // model id as reported by LM Studio
  embeddingModel: string | null; // null = lexical retrieval only
}

export type ModelKind = "llm" | "embedding" | "unknown";

export interface ModelInfo {
  id: string;
  kind: ModelKind;
  /** "loaded" | "not-loaded" when LM Studio reports it; null otherwise. */
  state: string | null;
}

export interface LlmStatus {
  reachable: boolean;
  /** Italian, user-facing, when not reachable (e.g. «LM Studio non risponde su http://127.0.0.1:1234.»). */
  message: string | null;
  detail: string | null;
  models: ModelInfo[];
}

export type EmbeddingState =
  | "disabled" // no embedding model configured
  | "idle" // all current chunks embedded with the configured model
  | "running"
  | "unreachable"; // LM Studio not reachable or the model failed: retried in the background

export interface EmbeddingStatus {
  state: EmbeddingState;
  model: string | null;
  /** Chunks of current versions in the project. */
  total: number;
  /** Of those, chunks embedded with `model`. */
  embedded: number;
  message: string | null;
}

export interface Conversation {
  id: string;
  projectId: string;
  title: string; // from the first question, trimmed; "Nuova conversazione" until then
  createdAt: string;
  updatedAt: string;
}

/**
 * - answer: generated by the model from evidence
 * - inventory: list of project documents built by Localis (no model involved)
 * - clarification: the question's document reference is ambiguous; `candidates` lists the options
 * - no_evidence: nothing relevant was found; the model was not called
 */
export type MessageKind = "question" | "answer" | "inventory" | "clarification" | "no_evidence";

export type MessageStatus = "complete" | "streaming" | "cancelled" | "error";

export type RetrievalMode = "lexical" | "hybrid";
export type RetrievalScope = "project" | "documents";

export interface RetrievalInfo {
  mode: RetrievalMode;
  scope: RetrievalScope;
  /** Documents the search was limited to (scope "documents"). */
  documentIds: string[];
  /** Why the scope was chosen: user selection, a title named in the question, or the conversation history. */
  scopeReason: "selection" | "title" | "history" | null;
  embeddingModel: string | null;
  query: string; // lexical query actually used (for the inspector)
}

/**
 * One retrieved passage. The same table holds three tiers:
 * raw results (`n` null), evidence passed to the model (`n` set) and citations (`cited` true).
 * Fields are a snapshot taken when the answer was produced, so they stay readable after deletions.
 */
export interface Source {
  rank: number; // 1-based position in the raw results
  n: number | null; // number given to the model as [n]; null = not passed in the prompt
  cited: boolean; // referenced in the answer as [n] (only possible when n != null)
  documentId: string;
  versionId: string;
  title: string;
  unit: number;
  unitKind: UnitKind;
  /** Passage text as passed to the model (or the raw result excerpt). */
  text: string;
  /** "position": not found by search, opening passage of a selected document (question without searchable terms). */
  via: "lexical" | "semantic" | "both" | "position";
  /** False when the document or version no longer exists. */
  available: boolean;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  kind: MessageKind;
  /** Raw Markdown as written by the user or produced by the model (never altered). */
  content: string;
  status: MessageStatus;
  error: AppError | null;
  model: string | null;
  createdAt: string;
  retrieval: RetrievalInfo | null; // assistant answers only
  sources: Source[]; // assistant answers only, ordered by rank
  candidates: { documentId: string; title: string }[]; // clarification only
}

export interface SendMessageInput {
  conversationId: string;
  text: string;
  /** Explicit selection: restrict retrieval to these documents (empty/absent = automatic). */
  documentIds?: string[];
}

/** Streamed over a Tauri Channel during send_message. Loading states are not stored in the history. */
export type ChatEvent =
  | { type: "accepted"; userMessage: ChatMessage; assistantMessageId: string }
  | { type: "phase"; phase: "retrieving" | "generating" }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: AppError; message: ChatMessage | null };
