import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AppError, WhisperModel, WhisperModelId } from "../api/types";
import { toAppError } from "../api/types";

/** Interval between refreshes while a model download runs (only then). */
export const MODEL_POLL_MS = 1000;

export interface WhisperModelsStore {
  models: WhisperModel[] | null;
  loadError: AppError | null;
  /** Error of the last cancel (download and delete report in their confirmation dialog). */
  actionError: AppError | null;
  downloading: boolean;
  reload: () => void;
  download: (id: WhisperModelId) => Promise<void>;
  cancel: (id: WhisperModelId) => Promise<void>;
  remove: (id: WhisperModelId) => Promise<void>;
  clearActionError: () => void;
}

export function useWhisperModels(): WhisperModelsStore {
  const [models, setModels] = useState<WhisperModel[] | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [generation, setGeneration] = useState(0);
  const request = useRef(0);

  const fetchModels = useCallback(async () => {
    const id = ++request.current;
    const next = await api.listWhisperModels();
    if (id !== request.current) return;
    setModels(next);
    setLoadError(null);
    setGeneration((g) => g + 1);
  }, []);

  const reload = useCallback(() => {
    fetchModels().catch((err: unknown) => setLoadError(toAppError(err)));
  }, [fetchModels]);

  useEffect(() => {
    reload();
  }, [reload]);

  const downloading = models?.some((m) => m.download !== null) ?? false;

  useEffect(() => {
    if (!downloading) return;
    const timer = window.setTimeout(() => {
      fetchModels().catch(() => setGeneration((g) => g + 1));
    }, MODEL_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [downloading, generation, fetchModels]);

  /** `report`: show a failure as actionError (actions confirmed in a dialog show it there instead). */
  const act = useCallback(async (run: () => Promise<WhisperModel[]>, report: boolean) => {
    setActionError(null);
    try {
      const next = await run();
      ++request.current;
      setModels(next);
      setGeneration((g) => g + 1);
    } catch (err) {
      if (report) setActionError(toAppError(err));
      throw toAppError(err);
    }
  }, []);

  return {
    models,
    loadError,
    actionError,
    downloading,
    reload,
    download: (id) => act(() => api.downloadWhisperModel(id), false),
    cancel: (id) => act(() => api.cancelWhisperDownload(id), true),
    remove: (id) => act(() => api.deleteWhisperModel(id), false),
    clearActionError: () => setActionError(null),
  };
}

/** Announces progress in steps (every 10 %), not on every tick. */
export function progressStep(percent: number | null, step = 10): number | null {
  if (percent == null) return null;
  return Math.min(100, Math.floor(percent / step) * step);
}

export function downloadPercent(model: WhisperModel): number | null {
  if (!model.download) return null;
  const { receivedBytes, totalBytes } = model.download;
  return totalBytes > 0 ? Math.min(100, Math.floor((receivedBytes / totalBytes) * 100)) : null;
}
