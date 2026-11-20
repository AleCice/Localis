// Grouped model choices («Locale (LM Studio)» / «Cloud») for the settings and the chat header.
import type { LlmStatus, ModelRef, Project } from "../api/types";
import { knownCloudModels, providerInfo, type CloudState } from "../hooks/useCloud";
import { isChatKind, isEmbeddingKind, refKey, refLabel } from "../lib/models";

export interface ModelOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ModelGroup {
  label: string;
  options: ModelOption[];
}

export const LOCAL_GROUP = "Locale (LM Studio)";
export const CLOUD_GROUP = "Cloud";

/** Why a cloud model cannot be used right now (null = usable). */
export function cloudUnavailableReason(
  cloud: CloudState,
  ref: ModelRef,
  project: Project | null,
  purpose: "chat" | "embedding",
): string | null {
  if (ref.provider === "lmstudio") return null;
  if (purpose === "chat" && project && project.cloudPolicy === "local_only") return "progetto solo locale";
  const info = providerInfo(cloud, ref.provider);
  if (info && !info.hasKey) return "nessuna chiave";
  return null;
}

interface BuildOptions {
  purpose: "chat" | "embedding";
  status: LlmStatus | null;
  cloud: CloudState;
  /** Models already in the settings: always listed so the current choice is visible. */
  configured: (ModelRef | null)[];
  /** Chat: cloud entries are disabled for a local-only project. */
  project?: Project | null;
}

export function buildModelGroups({ purpose, status, cloud, configured, project = null }: BuildOptions): ModelGroup[] {
  const fits = purpose === "chat" ? isChatKind : isEmbeddingKind;
  const local: ModelOption[] = [];
  const reported = status?.reachable ? status.models.filter(fits) : [];
  for (const m of reported) {
    local.push({
      value: refKey({ provider: "lmstudio", model: m.id }),
      label: m.state === "not-loaded" ? `${m.id} (non caricato)` : m.id,
    });
  }
  for (const ref of configured) {
    if (!ref || ref.provider !== "lmstudio" || reported.some((m) => m.id === ref.model)) continue;
    if (local.some((o) => o.value === refKey(ref))) continue;
    const why =
      status === null ? "" : status.reachable ? " (non trovato in LM Studio)" : " (LM Studio non raggiungibile)";
    local.push({ value: refKey(ref), label: `${ref.model}${why}` });
  }
  if (local.length === 0) {
    local.push({
      value: "__local-none",
      label:
        status === null
          ? "Verifica di LM Studio…"
          : status.reachable
            ? "Nessun modello in LM Studio"
            : "LM Studio non raggiungibile",
      disabled: true,
    });
  }

  const cloudRefs = knownCloudModels(
    cloud,
    purpose,
    configured.filter((r) => r && r.provider !== "lmstudio"),
  );
  const remote: ModelOption[] = cloudRefs.map((ref) => {
    const reason = cloudUnavailableReason(cloud, ref, project, purpose);
    return {
      value: refKey(ref),
      label: reason ? `${refLabel(ref)} — ${reason}` : refLabel(ref),
      disabled: reason !== null,
    };
  });
  if (remote.length === 0) {
    remote.push({
      value: "__cloud-none",
      label: "Nessun modello: caricali in Impostazioni → Provider cloud",
      disabled: true,
    });
  }
  return [
    { label: LOCAL_GROUP, options: local },
    { label: CLOUD_GROUP, options: remote },
  ];
}
