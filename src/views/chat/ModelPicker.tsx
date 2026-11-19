import { useState } from "react";
import type { AppError } from "../../api/types";
import { toAppError } from "../../api/types";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { chatModels, type LlmStore } from "../../hooks/useLlm";

/** Chat model selector for the chat header. Only lists models LM Studio actually reports. */
export function ModelPicker({ llm }: { llm: LlmStore }) {
  const { settings, status, checking } = llm;
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const showChecking = useDelayedFlag(checking && !status);

  if (!status || !settings) {
    return showChecking ? (
      <span className="model-state" role="status">
        <Spinner />
        Verifica di LM Studio…
      </span>
    ) : null;
  }

  const recheck = (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void llm.recheck()} disabled={checking} aria-busy={checking}>
      {checking ? <Spinner /> : null}
      Riprova
    </button>
  );

  if (!status.reachable) {
    return (
      <span className="model-picker">
        <span className="model-state is-off" title={status.message ?? undefined}>
          LM Studio non raggiungibile
        </span>
        {recheck}
      </span>
    );
  }

  const models = chatModels(status);
  if (models.length === 0) {
    return (
      <span className="model-picker">
        <span className="model-state is-off">Nessun modello di chat in LM Studio</span>
        {recheck}
      </span>
    );
  }

  const current = settings.chatModel ?? "";
  const missing = current !== "" && !models.some((m) => m.id === current);

  const choose = async (value: string) => {
    setError(null);
    setSaving(true);
    try {
      await llm.save({ ...settings, chatModel: value || null });
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <span className="model-picker">
      <label className="model-select">
        <span className="visually-hidden">Modello di chat</span>
        <select value={current} onChange={(e) => void choose(e.target.value)} disabled={saving} title="Modello di chat">
          {current === "" ? (
            <option value="" disabled>
              Scegli un modello
            </option>
          ) : null}
          {missing ? <option value={current}>{current} (non trovato in LM Studio)</option> : null}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.state === "not-loaded" ? " (non caricato)" : ""}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span className="field-error" role="alert">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}
