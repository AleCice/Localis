// Import of a file picked by the user: small files in one IPC call, audio/video and large files
// in consecutive chunks (beginUpload → uploadChunk… → finishUpload) with progress and cancellation.
import { api } from "../api/client";
import type { AppError, ImportResult } from "../api/types";
import { IMPORT_MAX_BYTES, MEDIA_IMPORT_MAX_BYTES, UPLOAD_CHUNK_BYTES } from "../api/types";
import { fileExtension, formatBytes } from "./format";

export const MEDIA_EXTENSIONS = ["mp3", "m4a", "wav", "mp4"] as const;

export function isMediaFileName(name: string): boolean {
  return (MEDIA_EXTENSIONS as readonly string[]).includes(fileExtension(name));
}

/** Size limit for this file (audio/video have their own, larger one). */
export function importLimit(name: string): number {
  return isMediaFileName(name) ? MEDIA_IMPORT_MAX_BYTES : IMPORT_MAX_BYTES;
}

/** Error for a file over its limit, or null. Checked before sending anything. */
export function checkImportSize(file: Pick<File, "name" | "size">): AppError | null {
  const limit = importLimit(file.name);
  if (file.size <= limit) return null;
  return { code: "too_large", message: `Il file supera il limite di ${formatBytes(limit)}.` };
}

export function needsChunkedUpload(file: Pick<File, "name" | "size">): boolean {
  return isMediaFileName(file.name) || file.size > UPLOAD_CHUNK_BYTES;
}

export const CANCELLED_UPLOAD: AppError = { code: "cancelled", message: "Importazione annullata." };

export interface UploadOptions {
  projectId: string;
  folderId?: string | null;
  /** Upload a new version of this document. */
  documentId?: string | null;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/**
 * Sends a file in consecutive chunks. On cancellation (signal) or on a failure the temporary
 * upload is discarded with cancelUpload and the promise rejects (CANCELLED_UPLOAD when cancelled).
 */
export async function uploadInChunks(file: File, options: UploadOptions): Promise<ImportResult> {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw CANCELLED_UPLOAD;
  const handle = await api.beginUpload({
    projectId: options.projectId,
    folderId: options.folderId ?? null,
    fileName: file.name,
    sizeBytes: file.size,
    lastModified: file.lastModified || null,
    documentId: options.documentId ?? null,
  });
  const chunk = handle.chunkBytes > 0 ? handle.chunkBytes : UPLOAD_CHUNK_BYTES;
  const discard = () => api.cancelUpload(handle.uploadId).catch(() => undefined);
  try {
    onProgress?.(0, file.size);
    for (let offset = 0; offset < file.size; offset += chunk) {
      if (signal?.aborted) throw CANCELLED_UPLOAD;
      const end = Math.min(offset + chunk, file.size);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (signal?.aborted) throw CANCELLED_UPLOAD;
      await api.uploadChunk(handle.uploadId, offset, bytes);
      onProgress?.(end, file.size);
    }
    if (signal?.aborted) throw CANCELLED_UPLOAD;
  } catch (err) {
    await discard();
    throw err;
  }
  // finishUpload consumes the upload on the backend whatever the outcome.
  return api.finishUpload(handle.uploadId);
}

/** Imports one file as a new document, choosing single-call or chunked transfer. */
export async function importFile(file: File, options: UploadOptions): Promise<ImportResult> {
  const tooLarge = checkImportSize(file);
  if (tooLarge) throw tooLarge;
  if (needsChunkedUpload(file)) return uploadInChunks(file, { ...options, documentId: null });
  const bytes = new Uint8Array(await file.arrayBuffer());
  return api.importDocument(bytes, {
    projectId: options.projectId,
    folderId: options.folderId ?? null,
    fileName: file.name,
    lastModified: file.lastModified || null,
  });
}
