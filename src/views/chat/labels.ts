import type { RetrievalInfo, Source, UnitKind } from "../../api/types";

export function unitLabel(unitKind: UnitKind, unit: number): string {
  return unitKind === "page" ? `p. ${unit}` : `blocco ${unit}`;
}

export function sourceLabel(source: Source): string {
  return `«${source.title}», ${unitLabel(source.unitKind, source.unit)}`;
}

/** Accessible name of a citation button. */
export function citationLabel(source: Source): string {
  const base = `Fonte ${source.n}: ${sourceLabel(source)}`;
  return source.available ? base : `${base} (documento non più disponibile)`;
}

export const SCOPE_REASON_LABEL: Record<NonNullable<RetrievalInfo["scopeReason"]>, string> = {
  selection: "selezione dei documenti",
  title: "documento nominato nella domanda",
  history: "documento della risposta precedente",
};

export const VIA_LABEL: Record<Source["via"], string> = {
  lexical: "lessicale",
  semantic: "semantica",
  both: "lessicale e semantica",
};

/** Short excerpt for compact lists. */
export function excerpt(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
