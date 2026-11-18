const dateFormatter = new Intl.DateTimeFormat("it-IT", { dateStyle: "long", timeStyle: "short" });

/** Formats an ISO 8601 timestamp for display in the Italian locale. */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormatter.format(date);
}

/** Counts user-perceived characters the same way the backend does (Unicode scalar values). */
export function charCount(value: string): number {
  return [...value].length;
}
