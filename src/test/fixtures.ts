import type {
  ChatMessage,
  CloudPreview,
  CloudProviderId,
  LlmSettings,
  ProviderInfo,
  Conversation,
  DocumentKind,
  DocumentVersion,
  Folder,
  Job,
  LibraryDocument,
  Project,
  SearchHit,
  Source,
  TextStatus,
  MediaLink,
  TranscriptSegment,
  UnitKind,
  WhisperModel,
  WhisperModelId,
} from "../api/types";

let counter = 0;

/** Synthetic project fixture. */
export function makeProject(name: string, overrides: Partial<Project> = {}): Project {
  counter += 1;
  const stamp = new Date(Date.UTC(2026, 2, 10, 9, 0, counter)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name,
    description: null,
    createdAt: stamp,
    updatedAt: stamp,
    cloudPolicy: "local_only",
    cloudEmbeddingConsent: false,
    ...overrides,
  };
}

const PROJECT_ID = "00000000-0000-4000-8000-0000000000aa";

function uuid(prefix: string): string {
  counter += 1;
  return `${prefix}000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function stamp(): string {
  counter += 1;
  return new Date(Date.UTC(2026, 2, 10, 9, 0, counter % 60)).toISOString();
}

export function makeFolder(name: string, overrides: Partial<Folder> = {}): Folder {
  const at = stamp();
  return { id: uuid("f0"), projectId: PROJECT_ID, parentId: null, name, createdAt: at, updatedAt: at, ...overrides };
}

const MEDIA: Record<DocumentKind, string> = {
  pdf: "application/pdf",
  text: "text/plain",
  markdown: "text/markdown",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  image: "image/png",
  audio: "audio/mpeg",
  video: "video/mp4",
};

/** Synthetic library document with one current version. */
export function makeDocument(
  title: string,
  options: {
    kind?: DocumentKind;
    status?: TextStatus;
    folderId?: string | null;
    version?: Partial<DocumentVersion>;
    versionCount?: number;
  } = {},
): LibraryDocument {
  const kind = options.kind ?? "pdf";
  const id = uuid("d0");
  const at = stamp();
  const current: DocumentVersion = {
    id: uuid("e0"),
    documentId: id,
    versionNo: options.versionCount ?? 1,
    originalName: title,
    kind,
    mediaType: MEDIA[kind],
    sizeBytes: 2048,
    sha256: "a".repeat(64),
    sourceModifiedAt: null,
    importedAt: at,
    textStatus:
      options.status ?? (kind === "image" || kind === "audio" || kind === "video" ? "not_applicable" : "extracted"),
    pageCount: kind === "pdf" ? 3 : null,
    imageWidth: kind === "image" ? 640 : kind === "video" ? 1280 : null,
    imageHeight: kind === "image" ? 480 : kind === "video" ? 720 : null,
    durationMs: kind === "audio" || kind === "video" ? 20 * 60 * 1000 : null,
    transcription: null,
    ...options.version,
  };
  return {
    id,
    projectId: PROJECT_ID,
    folderId: options.folderId ?? null,
    title,
    createdAt: at,
    updatedAt: at,
    current,
    versionCount: options.versionCount ?? 1,
  };
}

export function makeJob(doc: LibraryDocument, overrides: Partial<Job> = {}): Job {
  counter += 1;
  const at = stamp();
  return {
    id: counter,
    documentId: doc.id,
    versionId: doc.current.id,
    kind: "extract_text",
    state: "done",
    progress: null,
    attempts: 1,
    error: null,
    errorDetail: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

function unitKindOf(kind: DocumentKind): UnitKind {
  return kind === "pdf" ? "page" : kind === "audio" || kind === "video" ? "segment" : "block";
}

export function makeHit(doc: LibraryDocument, unit: number, snippet: string): SearchHit {
  return {
    documentId: doc.id,
    versionId: doc.current.id,
    title: doc.title,
    folderId: doc.folderId,
    unit,
    unitKind: unitKindOf(doc.current.kind),
    snippet,
  };
}

export const LIBRARY_PROJECT_ID = PROJECT_ID;

// ---------------------------------------------------------------- v0.3 chat

export function makeConversation(title: string, overrides: Partial<Conversation> = {}): Conversation {
  const at = stamp();
  return { id: uuid("c0"), projectId: PROJECT_ID, title, createdAt: at, updatedAt: at, ...overrides };
}

export function makeSource(doc: LibraryDocument, overrides: Partial<Source> = {}): Source {
  return {
    rank: 1,
    n: 1,
    cited: true,
    documentId: doc.id,
    versionId: doc.current.id,
    title: doc.title,
    unit: 2,
    unitKind: unitKindOf(doc.current.kind),
    text: "Il teorema degli zeri afferma che una funzione continua che cambia segno ha uno zero.",
    via: "lexical",
    available: true,
    ...overrides,
  };
}

export function makeMessage(
  conversation: Conversation,
  role: ChatMessage["role"],
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  const at = stamp();
  return {
    id: uuid("a0"),
    conversationId: conversation.id,
    role,
    kind: role === "user" ? "question" : "answer",
    content,
    status: "complete",
    error: null,
    model: role === "assistant" ? "qwen2.5-7b-instruct" : null,
    provider: role === "assistant" ? "lmstudio" : null,
    routeReason: null,
    usage: null,
    cost: null,
    createdAt: at,
    retrieval:
      role === "assistant"
        ? { mode: "lexical", scope: "project", documentIds: [], scopeReason: null, embeddingModel: null, embeddingProvider: null, query: '"teorema"* OR "zeri"' }
        : null,
    sources: [],
    candidates: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------- v0.4 cloud

export function makeProvider(id: CloudProviderId, overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  const meta: Record<CloudProviderId, Omit<ProviderInfo, "hasKey">> = {
    openai: { id: "openai", name: "OpenAI", host: "api.openai.com", supportsChat: true, supportsEmbeddings: true },
    anthropic: { id: "anthropic", name: "Anthropic", host: "api.anthropic.com", supportsChat: true, supportsEmbeddings: false },
    gemini: { id: "gemini", name: "Google Gemini", host: "generativelanguage.googleapis.com", supportsChat: true, supportsEmbeddings: true },
    deepseek: { id: "deepseek", name: "DeepSeek", host: "api.deepseek.com", supportsChat: true, supportsEmbeddings: false },
    qwen: { id: "qwen", name: "Qwen (Alibaba Cloud)", host: "dashscope-intl.aliyuncs.com", supportsChat: true, supportsEmbeddings: true },
  };
  return { ...meta[id], hasKey: false, ...overrides };
}

export const LLM_SETTINGS: LlmSettings = {
  baseUrl: "http://127.0.0.1:1234",
  chatModel: null,
  embeddingModel: null,
  routing: "manual",
  autoModels: [],
};

export function makePreview(overrides: Partial<CloudPreview> = {}): CloudPreview {
  return {
    token: "token-1",
    route: {
      model: { provider: "openai", model: "gpt-test" },
      cloud: true,
      reason: "Scelto da te nelle impostazioni.",
    },
    providerName: "OpenAI",
    host: "api.openai.com",
    question: "Cosa dice il teorema degli zeri?",
    sources: [
      { n: 1, title: "Dispensa.pdf", unit: 3, unitKind: "page", chars: 812, via: "lexical" },
      { n: 2, title: "Appunti.md", unit: 4, unitKind: "block", chars: 400, via: "lexical" },
    ],
    historyPairs: 1,
    historyChars: 230,
    totalChars: 12345,
    estInputTokens: 3087,
    maxOutputTokens: 2048,
    estCost: { min: { amount: 0.0077, currency: "USD" }, max: { amount: 0.0282, currency: "USD" } },
    queryEmbeddedBy: null,
    expiresAt: "2026-03-10T09:10:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------- v0.5 FARO

export function makeSegments(count: number, stepMs = 10_000): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    startMs: i * stepMs,
    endMs: (i + 1) * stepMs,
    text: `Frase sintetica numero ${i + 1} della lezione.`,
  }));
}

const WHISPER_META: Record<WhisperModelId, Pick<WhisperModel, "name" | "fileName" | "sizeBytes">> = {
  tiny: { name: "Whisper Tiny", fileName: "ggml-tiny.bin", sizeBytes: 77691713 },
  base: { name: "Whisper Base", fileName: "ggml-base.bin", sizeBytes: 147951465 },
  small: { name: "Whisper Small", fileName: "ggml-small.bin", sizeBytes: 487601967 },
  "large-v3-turbo-q5": { name: "Whisper Large v3 Turbo", fileName: "ggml-large-v3-turbo-q5_0.bin", sizeBytes: 574041195 },
};

export function makeWhisperModel(id: WhisperModelId, overrides: Partial<WhisperModel> = {}): WhisperModel {
  return { id, ...WHISPER_META[id], sha256: "b".repeat(64), installed: false, download: null, error: null, ...overrides };
}

export function makeLink(media: LibraryDocument, target: LibraryDocument, overrides: Partial<MediaLink> = {}): MediaLink {
  const at = stamp();
  return {
    id: uuid("1i"),
    projectId: PROJECT_ID,
    mediaDocumentId: media.id,
    mediaVersionId: media.current.id,
    startMs: 750_000,
    endMs: 900_000,
    targetDocumentId: target.id,
    targetVersionId: target.current.id,
    targetPage: target.current.kind === "pdf" ? 2 : null,
    region: null,
    note: null,
    createdAt: at,
    updatedAt: at,
    mediaTitle: media.title,
    targetTitle: target.title,
    available: true,
    ...overrides,
  };
}
