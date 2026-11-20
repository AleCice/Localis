import { useState } from "react";
import type { AppError, Project } from "../../api/types";
import { toAppError } from "../../api/types";
import { GroupedSelect } from "../../components/GroupedSelect";
import { Spinner } from "../../components/Spinner";
import type { Cloud } from "../../hooks/useCloud";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import type { LlmStore } from "../../hooks/useLlm";
import { isCloud, parseRefKey, providerName, refKey } from "../../lib/models";
import { buildModelGroups } from "../modelOptions";

const AUTO = "auto";

/**
 * Chat model selector for the chat header: LM Studio models it reports, cloud models known to
 * Localis (loaded in Impostazioni, priced or configured) and «Automatico» when routing is set up.
 */
export function ModelPicker({ llm, cloud, project }: { llm: LlmStore; cloud: Cloud; project: Project }) {
  const { settings, status, checking } = llm;
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const showChecking = useDelayedFlag(checking && !status);

  if (!settings) {
    return showChecking ? (
      <span className="model-state" role="status">
        <Spinner />
        Verifica dei modelli…
      </span>
    ) : null;
  }

  const groups = buildModelGroups({
    purpose: "chat",
    status,
    cloud,
    configured: [settings.chatModel, ...settings.autoModels],
    project,
  });
  const offerAuto = settings.routing === "auto" || settings.autoModels.length > 0;
  const value = settings.routing === "auto" ? AUTO : settings.chatModel ? refKey(settings.chatModel) : "";

  const choose = async (next: string) => {
    setError(null);
    setSaving(true);
    try {
      if (next === AUTO) await llm.save({ ...settings, routing: "auto" });
      else {
        const ref = parseRefKey(next);
        if (ref) await llm.save({ ...settings, routing: "manual", chatModel: ref });
      }
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setSaving(false);
    }
  };

  const manualCloud = settings.routing === "manual" && isCloud(settings.chatModel) ? settings.chatModel : null;
  let indicator: { text: string; off: boolean } | null = null;
  if (manualCloud) {
    indicator =
      project.cloudPolicy === "local_only"
        ? { text: "Cloud non consentito in questo progetto", off: true }
        : { text: `Cloud: ${providerName(manualCloud.provider)} · ${manualCloud.model}`, off: false };
  }

  return (
    <span className="model-picker">
      <label className="model-select">
        <span className="visually-hidden">Modello di chat</span>
        <GroupedSelect
          value={value}
          groups={groups}
          leading={offerAuto ? [{ value: AUTO, label: "Automatico" }] : []}
          placeholder="Scegli un modello"
          onChange={(v) => void choose(v)}
          disabled={saving}
          title="Modello di chat"
        />
      </label>
      {indicator ? (
        <span className={indicator.off ? "model-state is-off" : "model-state"}>{indicator.text}</span>
      ) : null}
      {status && !status.reachable ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void llm.recheck()}
          disabled={checking}
          aria-busy={checking}
          title={status.message ?? "LM Studio non raggiungibile"}
          aria-label="Riprova a contattare LM Studio"
        >
          {checking ? <Spinner /> : null}
          Riprova
        </button>
      ) : null}
      {error ? (
        <span className="field-error" role="alert">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}
