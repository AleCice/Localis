// Helpers for model references, provider names, money and token figures (v0.4).
import type { CloudProviderId, ModelInfo, ModelRef, Money, ProviderId, TokenUsage } from "../api/types";

/** Display names; the backend's ProviderInfo.name is the same text (used where no ProviderInfo is at hand). */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  lmstudio: "LM Studio",
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  deepseek: "DeepSeek",
  qwen: "Qwen (Alibaba Cloud)",
};

export const CLOUD_PROVIDERS: CloudProviderId[] = ["openai", "anthropic", "gemini", "deepseek", "qwen"];

export function providerName(id: ProviderId | null | undefined): string {
  return id ? (PROVIDER_NAMES[id] ?? id) : "";
}

export function isCloud(ref: ModelRef | null | undefined): ref is ModelRef & { provider: CloudProviderId } {
  return !!ref && ref.provider !== "lmstudio";
}

/** Stable string form for <select> values and React keys: "provider:model". */
export function refKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export function parseRefKey(key: string): ModelRef | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  return { provider: key.slice(0, at) as ProviderId, model: key.slice(at + 1) };
}

export function sameRef(a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean {
  return !!a && !!b && a.provider === b.provider && a.model === b.model;
}

/** «OpenAI · gpt-4o», or just the model id for LM Studio when `localPlain`. */
export function refLabel(ref: ModelRef, localPlain = false): string {
  if (ref.provider === "lmstudio" && localPlain) return ref.model;
  return `${providerName(ref.provider)} · ${ref.model}`;
}

export function isChatKind(m: ModelInfo): boolean {
  return m.kind === "llm" || m.kind === "unknown";
}

export function isEmbeddingKind(m: ModelInfo): boolean {
  return m.kind === "embedding" || m.kind === "unknown";
}

const integer = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0 });

export function formatCount(value: number): string {
  return integer.format(value);
}

/** Amount in the user's currency; small amounts keep enough digits to be meaningful. */
export function formatMoney(money: Money): string {
  const abs = Math.abs(money.amount);
  const max = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat("it-IT", {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: max,
    }).format(money.amount);
  } catch {
    // Not an ISO 4217 code: show the number and the code as entered.
    return `${new Intl.NumberFormat("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: max }).format(money.amount)} ${money.currency}`;
  }
}

/** «1.234 token in ingresso, 456 in uscita»; null when the provider reported nothing. */
export function formatUsage(usage: TokenUsage | null): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`${formatCount(usage.inputTokens)} token in ingresso`);
  if (usage.outputTokens != null) parts.push(`${formatCount(usage.outputTokens)} in uscita`);
  return parts.length > 0 ? parts.join(", ") : null;
}

const decimal = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 6 });

export function formatDecimal(value: number): string {
  return decimal.format(value);
}

/** Parses a user-entered price ("2,50" or "2.50"); null when not a finite non-negative number. */
export function parsePrice(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, "");
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value : null;
}
