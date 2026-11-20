import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { AppError, EmbeddingStatus } from "../api/types";
import { toAppError } from "../api/types";
import { providerName } from "../lib/models";

/** Interval between embedding status checks while indexing runs. */
export const EMBEDDING_POLL_MS = 2000;

export function embeddingStateLabel(status: EmbeddingStatus): string {
  switch (status.state) {
    case "disabled":
      return "Non attiva: nessun modello di embedding";
    case "idle":
      return "Completata";
    case "running":
      return "In corso";
    case "unreachable":
      return status.provider && status.provider !== "lmstudio"
        ? `In attesa di ${providerName(status.provider)}`
        : "In attesa di LM Studio";
    case "needs_consent":
      return "In attesa di consenso: per questo progetto la ricerca resta lessicale";
  }
}

/** Embedding status of a project; polls while indexing runs (and slowly while the provider is unreachable). */
export function useEmbeddingStatus(projectId: string | null, key: string | null) {
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let alive = true;
    Promise.resolve()
      .then(() => api.getEmbeddingStatus(projectId))
      .then(
        (value) => {
          if (!alive) return;
          setStatus(value);
          setError(null);
        },
        (err: unknown) => alive && setError(toAppError(err)),
      );
    return () => {
      alive = false;
    };
  }, [projectId, key, tick]);

  // The embedder retries in the background, so the state can change without user action.
  useEffect(() => {
    if (status?.state !== "running" && status?.state !== "unreachable") return;
    const delay = status.state === "running" ? EMBEDDING_POLL_MS : EMBEDDING_POLL_MS * 10;
    const timer = window.setTimeout(() => setTick((t) => t + 1), delay);
    return () => window.clearTimeout(timer);
  }, [status]);

  return { status, error, refresh: () => setTick((t) => t + 1) };
}
