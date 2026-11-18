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

const shortDateFormatter = new Intl.DateTimeFormat("it-IT", { dateStyle: "medium" });

/** Short date (e.g. "12 nov 2026") for dense lists. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : shortDateFormatter.format(date);
}

const numberFormatter = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 1 });

/** Human-readable size with binary multiples, labelled the way file managers do (KB, MB, GB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${numberFormatter.format(value)} ${units[unit]}`;
}

/** Lowercase extension without the dot ("" when there is none). */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
