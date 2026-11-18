import type {
  DocumentKind,
  DocumentVersion,
  Folder,
  Job,
  LibraryDocument,
  Project,
  SearchHit,
  TextStatus,
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
    textStatus: options.status ?? (kind === "image" ? "not_applicable" : "extracted"),
    pageCount: kind === "pdf" ? 3 : null,
    imageWidth: kind === "image" ? 640 : null,
    imageHeight: kind === "image" ? 480 : null,
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
    attempts: 1,
    error: null,
    errorDetail: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function makeHit(doc: LibraryDocument, unit: number, snippet: string): SearchHit {
  return {
    documentId: doc.id,
    versionId: doc.current.id,
    title: doc.title,
    folderId: doc.folderId,
    unit,
    unitKind: doc.current.kind === "pdf" ? "page" : "block",
    snippet,
  };
}

export const LIBRARY_PROJECT_ID = PROJECT_ID;
