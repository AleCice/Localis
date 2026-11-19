import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AppError, LlmSettings, LlmStatus, ModelInfo } from "../api/types";
import { toAppError } from "../api/types";

export interface LlmStore {
  settings: LlmSettings | null;
  status: LlmStatus | null;
  /** A status check is in progress. */
  checking: boolean;
  /** Settings could not be read. */
  loadError: AppError | null;
  /** Contacts LM Studio again. */
  recheck: () => Promise<void>;
  /** Reads the settings again (they may have changed in another view) and rechecks. */
  reload: () => void;
  /** Saves (backend validates); rejects with the AppError so forms can show it at the field. */
  save: (next: LlmSettings) => Promise<LlmSettings>;
}

/** Models usable for chat: `llm`, plus `unknown` when LM Studio only reports the OpenAI list. */
export function chatModels(status: LlmStatus | null): ModelInfo[] {
  return (status?.models ?? []).filter((m) => m.kind === "llm" || m.kind === "unknown");
}

export function embeddingModels(status: LlmStatus | null): ModelInfo[] {
  return (status?.models ?? []).filter((m) => m.kind === "embedding" || m.kind === "unknown");
}

export function useLlm(): LlmStore {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const checkId = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const recheck = useCallback(async () => {
    const id = ++checkId.current;
    setChecking(true);
    try {
      const next = await api.getLlmStatus();
      if (alive.current && id === checkId.current) setStatus(next);
    } catch (err) {
      const error = toAppError(err);
      if (alive.current && id === checkId.current)
        setStatus({ reachable: false, message: error.message, detail: error.detail ?? null, models: [] });
    } finally {
      if (alive.current && id === checkId.current) setChecking(false);
    }
  }, []);

  const reload = useCallback(() => {
    api.getLlmSettings().then(
      (value) => {
        if (!alive.current) return;
        setSettings(value);
        setLoadError(null);
      },
      (err: unknown) => alive.current && setLoadError(toAppError(err)),
    );
    void recheck();
  }, [recheck]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = useCallback(async (next: LlmSettings) => {
    const saved = await api.setLlmSettings(next);
    if (alive.current) setSettings(saved);
    return saved;
  }, []);

  return { settings, status, checking, loadError, recheck, reload, save };
}
