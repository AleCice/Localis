import type { RetrievalInfo, Source, UnitKind } from "../../api/types";
import { formatClock } from "../../lib/time";

/** «p. 3», «blocco 4», or the segment's timestamp («00:12:34») for recordings. */
export function unitLabel(unitKind: UnitKind, unit: number, startMs?: number | null): string {
  if (unitKind === "segment") return startMs != null ? formatClock(startMs) : `segmento ${unit}`;
  return unitKind === "page" ? `p. ${unit}` : `blocco ${unit}`;
}

export function sourceLabel(source: Source): string {
  return `«${source.title}», ${unitLabel(source.unitKind, source.unit, source.startMs)}`;
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
  position: "inizio del documento (nessun termine da cercare)",
};

/** Short excerpt for compact lists. */
export function excerpt(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
