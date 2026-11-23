import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { ImportResult } from "../api/types";
import { IMPORT_MAX_BYTES, MEDIA_IMPORT_MAX_BYTES, UPLOAD_CHUNK_BYTES } from "../api/types";
import { makeDocument } from "../test/fixtures";
import { CANCELLED_UPLOAD, checkImportSize, importFile, needsChunkedUpload, uploadInChunks } from "./upload";

vi.mock("../api/client", () => ({
  api: {
    importDocument: vi.fn(),
    beginUpload: vi.fn(),
    uploadChunk: vi.fn(),
    finishUpload: vi.fn(),
    cancelUpload: vi.fn(),
  },
}));

const mockedApi = vi.mocked(api);
const imported: ImportResult = { status: "imported", document: makeDocument("lezione.mp3", { kind: "audio" }) };

function sized(name: string, size: number) {
  const file = new File(["x"], name, { lastModified: Date.UTC(2026, 0, 2) });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedApi.beginUpload.mockResolvedValue({ uploadId: "u1", chunkBytes: 4 });
  mockedApi.uploadChunk.mockResolvedValue(undefined);
  mockedApi.finishUpload.mockResolvedValue(imported);
  mockedApi.cancelUpload.mockResolvedValue(undefined);
  mockedApi.importDocument.mockResolvedValue(imported);
});

describe("chunked upload", () => {
  it("sends consecutive chunks with their offsets, reports progress and finishes", async () => {
    const file = new File(["0123456789"], "lezione.wav", { lastModified: 5 });
    const progress: [number, number][] = [];
    const result = await uploadInChunks(file, {
      projectId: "p1",
      folderId: "f1",
      onProgress: (sent, total) => progress.push([sent, total]),
    });
    expect(result).toBe(imported);
    expect(mockedApi.beginUpload).toHaveBeenCalledWith({
      projectId: "p1",
      folderId: "f1",
      fileName: "lezione.wav",
      sizeBytes: 10,
      lastModified: 5,
      documentId: null,
    });
    const calls = mockedApi.uploadChunk.mock.calls.map(([id, offset, bytes]) => [id, offset, new TextDecoder().decode(bytes)]);
    expect(calls).toEqual([
      ["u1", 0, "0123"],
      ["u1", 4, "4567"],
      ["u1", 8, "89"],
    ]);
    expect(progress).toEqual([
      [0, 10],
      [4, 10],
      [8, 10],
      [10, 10],
    ]);
    expect(mockedApi.finishUpload).toHaveBeenCalledWith("u1");
    expect(mockedApi.cancelUpload).not.toHaveBeenCalled();
  });

  it("cancels: stops sending, discards the upload with cancelUpload and rejects as cancelled", async () => {
    const controller = new AbortController();
    mockedApi.uploadChunk.mockImplementation(async (_id, offset) => {
      if (offset === 4) controller.abort();
    });
    const file = new File(["0123456789"], "lezione.mp3");
    await expect(uploadInChunks(file, { projectId: "p1", signal: controller.signal })).rejects.toBe(CANCELLED_UPLOAD);
    expect(mockedApi.uploadChunk).toHaveBeenCalledTimes(2);
    expect(mockedApi.cancelUpload).toHaveBeenCalledWith("u1");
    expect(mockedApi.finishUpload).not.toHaveBeenCalled();
  });

  it("discards the upload when a chunk fails", async () => {
    mockedApi.uploadChunk.mockRejectedValueOnce({ code: "storage", message: "Disco pieno." });
    await expect(uploadInChunks(new File(["0123456789"], "a.mp4"), { projectId: "p1" })).rejects.toMatchObject({
      code: "storage",
    });
    expect(mockedApi.cancelUpload).toHaveBeenCalledWith("u1");
  });

  it("uploads a new version of a document when documentId is given", async () => {
    await uploadInChunks(new File(["abc"], "lezione.mp3"), { projectId: "p1", documentId: "d1" });
    expect(mockedApi.beginUpload).toHaveBeenCalledWith(expect.objectContaining({ documentId: "d1" }));
  });
});

describe("import routing and limits", () => {
  it("uses chunks for every audio/video and for large files, a single call for small files", async () => {
    expect(needsChunkedUpload(sized("a.mp3", 10))).toBe(true);
    expect(needsChunkedUpload(sized("A.MP4", 10))).toBe(true);
    expect(needsChunkedUpload(sized("a.pdf", UPLOAD_CHUNK_BYTES))).toBe(false);
    expect(needsChunkedUpload(sized("a.pdf", UPLOAD_CHUNK_BYTES + 1))).toBe(true);

    await importFile(new File(["ciao"], "note.txt"), { projectId: "p1" });
    expect(mockedApi.importDocument).toHaveBeenCalledTimes(1);
    expect(mockedApi.beginUpload).not.toHaveBeenCalled();
    await importFile(new File(["RIFF"], "a.wav"), { projectId: "p1" });
    expect(mockedApi.beginUpload).toHaveBeenCalledTimes(1);
  });

  it("checks the size limit before sending anything: 4 GB for media, 200 MB for the rest", async () => {
    expect(checkImportSize(sized("a.mp4", MEDIA_IMPORT_MAX_BYTES))).toBeNull();
    expect(checkImportSize(sized("a.mp4", MEDIA_IMPORT_MAX_BYTES + 1))).toMatchObject({ code: "too_large" });
    expect(checkImportSize(sized("a.pdf", IMPORT_MAX_BYTES + 1))).toMatchObject({
      code: "too_large",
      message: "Il file supera il limite di 200 MB.",
    });
    await expect(importFile(sized("a.mp3", MEDIA_IMPORT_MAX_BYTES + 1), { projectId: "p1" })).rejects.toMatchObject({
      code: "too_large",
      message: "Il file supera il limite di 4 GB.",
    });
    expect(mockedApi.beginUpload).not.toHaveBeenCalled();
    expect(mockedApi.importDocument).not.toHaveBeenCalled();
  });
});
