// Timestamps of recordings: shown as m:ss / mm:ss (or h:mm:ss past one hour), typed as the same.

/** Formats milliseconds as «mm:ss», or «h:mm:ss» when `ms` (or `reference`) reaches one hour. */
export function formatTimestamp(ms: number, reference = 0): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (h > 0 || reference >= 3_600_000) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** Fixed «hh:mm:ss» form used for citations (e.g. 00:12:34). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** Spoken form for accessible names: «12 minuti e 5 secondi». */
export function spokenTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(h === 1 ? "1 ora" : `${h} ore`);
  if (m) parts.push(m === 1 ? "1 minuto" : `${m} minuti`);
  if (s || parts.length === 0) parts.push(s === 1 ? "1 secondo" : `${s} secondi`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}` : parts[0]!;
}

/** Interval «12:30–15:00» (both ends in the same form). */
export function formatInterval(startMs: number, endMs: number): string {
  return `${formatTimestamp(startMs, endMs)}–${formatTimestamp(endMs, endMs)}`;
}

/**
 * Parses «ss», «m:ss», «mm:ss» or «h:mm:ss» (seconds may carry a decimal part with «.» or «,»).
 * Returns milliseconds, or null when the text is not a valid time.
 */
export function parseTimestamp(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!text) return null;
  const parts = text.split(":");
  if (parts.length > 3) return null;
  const secondsPart = parts[parts.length - 1]!;
  if (!/^\d+(\.\d{1,3})?$/.test(secondsPart)) return null;
  const rest = parts.slice(0, -1);
  if (rest.some((p) => !/^\d+$/.test(p))) return null;
  const seconds = Number(secondsPart);
  if (rest.length > 0 && seconds >= 60) return null;
  let minutes = 0;
  let hours = 0;
  if (rest.length === 1) minutes = Number(rest[0]);
  if (rest.length === 2) {
    hours = Number(rest[0]);
    minutes = Number(rest[1]);
    if (minutes >= 60) return null;
  }
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
}
