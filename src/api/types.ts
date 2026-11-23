// Contract between the React frontend and the Tauri backend (v0.1 projects, v0.2 library).
// Owner: main agent. Mirrors the serde types in src-tauri/src/commands.rs.

export interface Project {
  id: string; // UUID v4
  name: string;
  description: string | null;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  /** v0.4: "local_only" (default) never sends anything to cloud providers. */
  cloudPolicy: CloudPolicy;
  /** v0.4: explicit consent to send this project's passages to the configured cloud embedding provider. */
  cloudEmbeddingConsent: boolean;
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
  | "llm_unavailable" // model provider not reachable, invalid key, no model selected or the model failed
  | "consent_required" // v0.4: a cloud send without a valid confirmation, or a local-only project
  | "keyring_unavailable" // v0.4: the system keychain cannot be used (no API key is stored elsewhere)
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
export const IMPORT_EXTENSIONS = ["pdf", "txt", "md", "markdown", "docx", "png", "jpg", "jpeg", "gif", "webp", "mp3", "m4a", "wav", "mp4"] as const;
/** v0.5: max size of an audio/video file (imported in chunks, see beginUpload). */
export const MEDIA_IMPORT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** v0.5: files larger than this (and all audio/video) are imported in chunks of this size. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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

export type DocumentKind = "pdf" | "text" | "markdown" | "docx" | "image" | "audio" | "video";

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
  imageWidth: number | null; // images and video
  imageHeight: number | null;
  /** v0.5: audio/video duration in milliseconds (null for other kinds or if unknown). */
  durationMs: number | null;
  /** v0.5: audio/video only, when a transcription exists. */
  transcription: TranscriptionInfo | null;
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
  /** v0.5: transcript segments only. */
  startMs?: number | null;
  endMs?: number | null;
}

/** v0.5: "segment" = transcript segment of an audio/video (unit = 1-based segment index; see startMs). */
export type UnitKind = "page" | "block" | "segment";

export interface SearchHit {
  documentId: string;
  versionId: string;
  title: string;
  folderId: string | null;
  unit: number;
  unitKind: UnitKind;
  /** Plain text excerpt; matched terms are wrapped in U+0002 (start) and U+0003 (end). */
  snippet: string;
  /** v0.5: start of the segment for unitKind "segment". */
  startMs?: number | null;
}

export const SNIPPET_MARK_START = "\u0002";
export const SNIPPET_MARK_END = "\u0003";

export type JobState = "queued" | "running" | "done" | "failed";

export interface Job {
  id: number;
  documentId: string;
  versionId: string;
  kind: "extract_text" | "transcribe";
  state: JobState;
  /** v0.5: 0–100 while a transcription runs; null when unknown. */
  progress: number | null;
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
  baseUrl: string; // LM Studio, default "http://127.0.0.1:1234"
  /** v0.4: chat model on any provider; null = none chosen. */
  chatModel: ModelRef | null;
  /** v0.4: embedding model on LM Studio or a cloud provider; null = lexical retrieval only. */
  embeddingModel: ModelRef | null;
  /** v0.4 PRISM: "manual" uses chatModel; "auto" picks per question from autoModels (see RouteDecision). */
  routing: "manual" | "auto";
  /** Ordered candidates for automatic routing (local ones are always preferred when available). */
  autoModels: ModelRef[];
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
  | "unreachable" // provider not reachable or the model failed: retried in the background
  /** v0.4: cloud embedding configured but this project is local-only or has not given consent. */
  | "needs_consent";

export interface EmbeddingStatus {
  state: EmbeddingState;
  /** v0.4 */
  provider: ProviderId | null;
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
  /** v0.4 */
  embeddingProvider: ProviderId | null;
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
  /** v0.5: start of the transcript segment for unitKind "segment". */
  startMs?: number | null;
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
  /** v0.4: provider of `model` (assistant answers produced by a model). */
  provider: ProviderId | null;
  /** v0.4: why the model was chosen (PRISM), shown in the inspector. */
  routeReason: string | null;
  /** v0.4: token usage as reported by the provider, when it reports it. */
  usage: TokenUsage | null;
  /** v0.4: cost computed from `usage` and the user's prices; null when unknown. */
  cost: Money | null;
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
  /** v0.4: required when the route is a cloud model: token from prepareCloudSend after the user confirmed. */
  confirmToken?: string;
}

/** Streamed over a Tauri Channel during send_message. Loading states are not stored in the history. */
export type ChatEvent =
  | { type: "accepted"; userMessage: ChatMessage; assistantMessageId: string }
  | { type: "phase"; phase: "retrieving" | "generating" }
  | { type: "delta"; text: string }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; error: AppError; message: ChatMessage | null };

// ---------------------------------------------------------------- v0.4 Cloud (Model Mesh + PRISM)

export type ProviderId = "lmstudio" | "openai" | "anthropic" | "gemini" | "deepseek" | "qwen";
export type CloudProviderId = Exclude<ProviderId, "lmstudio">;

export interface ModelRef {
  provider: ProviderId;
  model: string; // id as reported by the provider
}

export type CloudPolicy = "local_only" | "cloud_allowed";

export interface Money {
  amount: number;
  currency: string; // e.g. "USD": as entered by the user in prices
}

export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ProviderInfo {
  id: CloudProviderId;
  name: string; // "OpenAI", "Anthropic", "Google Gemini", "DeepSeek", "Qwen (Alibaba Cloud)"
  /** The only host Localis contacts for this provider. */
  host: string;
  /** True when an API key is stored in the system keychain (the key itself is never returned). */
  hasKey: boolean;
  supportsChat: boolean;
  supportsEmbeddings: boolean;
}

export interface KeyringStatus {
  available: boolean;
  /** Italian, user-facing, when not available (e.g. no Secret Service on Linux). */
  message: string | null;
  detail: string | null;
}

export interface ProviderModels {
  provider: CloudProviderId;
  reachable: boolean;
  message: string | null; // e.g. «Chiave API non valida.» / «OpenAI non raggiungibile.»
  detail: string | null;
  models: ModelInfo[];
}

/** User-entered price per million tokens; Localis ships no prices (they change too often). */
export interface ModelPrice {
  provider: CloudProviderId;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  currency: string;
}

/** PRISM decision for one question. */
export interface RouteDecision {
  model: ModelRef;
  cloud: boolean;
  /** Italian, short: e.g. «Scelto automaticamente: LM Studio non è raggiungibile; il modello cloud più economico tra quelli consentiti.» */
  reason: string;
}

export interface CloudPreview {
  /** Pass back as SendMessageInput.confirmToken to send exactly this payload. Expires after 10 minutes. */
  token: string;
  route: RouteDecision;
  providerName: string;
  host: string;
  question: string;
  /** Sources included in the request, as they will be sent. */
  sources: { n: number; title: string; unit: number; unitKind: UnitKind; chars: number; via: Source["via"] }[];
  historyPairs: number;
  historyChars: number;
  /** Total characters sent (system prompt + history + sources + question). */
  totalChars: number;
  estInputTokens: number; // rough estimate: characters / 4
  maxOutputTokens: number; // the request's output limit
  /** From the user's prices; null if no price is set for this model. */
  estCost: { min: Money; max: Money } | null;
  /** When the question itself was embedded by a cloud provider during retrieval (project consent given). */
  queryEmbeddedBy: ModelRef | null;
  /** Retrieval outcome, e.g. no_evidence/inventory never need the cloud: then prepareCloudSend returns null. */
  expiresAt: string;
}

export interface CloudEmbeddingEstimate {
  provider: CloudProviderId;
  model: string;
  /** Passages of current versions not yet embedded with this model. */
  chunks: number;
  chars: number;
  estTokens: number;
  estCost: Money | null;
}

export type CloudPurpose = "chat" | "query_embedding" | "index_embedding" | "list_models";

/** Local log of every request sent to a cloud provider. */
export interface CloudRequest {
  id: number;
  createdAt: string;
  provider: CloudProviderId;
  model: string | null;
  purpose: CloudPurpose;
  projectId: string | null;
  conversationId: string | null;
  charsSent: number;
  usage: TokenUsage | null;
  cost: Money | null;
  ok: boolean;
  error: string | null;
}

// ---------------------------------------------------------------- v0.5 FARO (lectures: audio/video, transcription, timeline)

/** Chunked import (all audio/video, and any file over UPLOAD_CHUNK_BYTES). */
export interface BeginUploadInput {
  projectId: string;
  folderId?: string | null;
  fileName: string;
  sizeBytes: number;
  lastModified?: number | null;
  /** Set to upload a new version of this document instead of a new document. */
  documentId?: string | null;
}

export interface UploadHandle {
  uploadId: string;
  chunkBytes: number;
}

export type WhisperModelId = "tiny" | "base" | "small" | "large-v3-turbo-q5";

export interface WhisperModel {
  id: WhisperModelId;
  name: string; // e.g. "Whisper Small"
  fileName: string; // e.g. "ggml-small.bin"
  sizeBytes: number;
  sha256: string;
  /** Downloaded and verified in the app data directory. */
  installed: boolean;
  download: { receivedBytes: number; totalBytes: number } | null;
  /** Italian, user-facing, after a failed download. */
  error: string | null;
}

export type TranscriptionLanguage = "auto" | "it" | "en" | "fr" | "de" | "es";

export interface TranscriptionInfo {
  model: WhisperModelId;
  language: string; // detected or chosen ISO code
  createdAt: string;
  segmentCount: number;
}

export interface TranscriptSegment {
  index: number; // 1-based (= TextUnit.unit)
  startMs: number;
  endMs: number;
  text: string;
}

/** Non-destructive region on a PDF page or an image, normalised to 0..1 of its width/height. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Manual link between an interval of a recording and a slide/PDF page or a photo (optionally a region). */
export interface MediaLink {
  id: string;
  projectId: string;
  mediaDocumentId: string;
  mediaVersionId: string;
  startMs: number;
  endMs: number;
  targetDocumentId: string;
  targetVersionId: string;
  /** PDF page (1-based); null for images. */
  targetPage: number | null;
  region: Region | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** Snapshot titles for display; `available` false when the media or target no longer exists. */
  mediaTitle: string;
  targetTitle: string;
  available: boolean;
}

export interface MediaLinkInput {
  mediaVersionId: string;
  startMs: number;
  endMs: number;
  targetVersionId: string;
  targetPage?: number | null;
  region?: Region | null;
  note?: string | null;
}
