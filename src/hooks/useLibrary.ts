import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AppError, Folder, Job, LibraryDocument } from "../api/types";
import { toAppError } from "../api/types";
import type { LoadStatus } from "./useProjects";

/** Interval between refreshes while text extraction is queued or running. */
export const POLL_INTERVAL_MS = 1000;

export interface LibraryStore {
  status: LoadStatus;
  loadError: AppError | null;
  folders: Folder[];
  documents: LibraryDocument[];
  jobs: Job[];
  /** True while some extraction is queued or running (the store polls meanwhile). */
  working: boolean;
  /** Full reload with loading state (first load, «Riprova»). */
  reload: () => void;
  /** Quiet refresh of folders, documents and jobs after a change. */
  refresh: () => Promise<void>;
}

export function isWorking(documents: LibraryDocument[], jobs: Job[]): boolean {
  return (
    documents.some((d) => d.current.textStatus === "pending") ||
    jobs.some((j) => j.state === "queued" || j.state === "running")
  );
}

export function useLibrary(projectId: string): LibraryStore {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [documents, setDocuments] = useState<LibraryDocument[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  // Bumped after every successful fetch so the polling effect re-arms.
  const [generation, setGeneration] = useState(0);
  // Separate sequence numbers: a poll (documents + jobs) must not discard a newer folder list.
  const requestId = useRef(0);
  const folderRequestId = useRef(0);
  const reloadId = useRef(0);

  const fetchAll = useCallback(
    async (withFolders: boolean) => {
      const id = ++requestId.current;
      const folderId = withFolders ? ++folderRequestId.current : 0;
      const [nextFolders, nextDocuments, nextJobs] = await Promise.all([
        withFolders ? api.listFolders(projectId) : null,
        api.listDocuments(projectId),
        api.listJobs(projectId),
      ]);
      if (nextFolders && folderId === folderRequestId.current) setFolders(nextFolders);
      if (id !== requestId.current) return;
      setDocuments(nextDocuments);
      setJobs(nextJobs);
      setGeneration((g) => g + 1);
    },
    [projectId],
  );

  const reload = useCallback(() => {
    // Only the latest reload settles the status: an older one (e.g. the effect running twice in
    // development) must not mark the store ready before its data is in.
    const id = ++reloadId.current;
    setStatus("loading");
    setLoadError(null);
    fetchAll(true).then(
      () => {
        if (id === reloadId.current) setStatus("ready");
      },
      (err: unknown) => {
        if (id !== reloadId.current) return;
        setLoadError(toAppError(err));
        setStatus("error");
      },
    );
  }, [fetchAll]);

  const refresh = useCallback(async () => {
    try {
      await fetchAll(true);
    } catch {
      /* a failed quiet refresh keeps the last known state; the next action retries */
    }
  }, [fetchAll]);

  useEffect(() => {
    reload();
  }, [reload]);

  const working = isWorking(documents, jobs);

  useEffect(() => {
    if (status !== "ready" || !working) return;
    const timer = window.setTimeout(() => {
      fetchAll(false).catch(() => {
        // Transient failure: try again on the next tick.
        setGeneration((g) => g + 1);
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [status, working, generation, fetchAll]);

  return { status, loadError, folders, documents, jobs, working, reload, refresh };
}
