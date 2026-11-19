// Safe access to UI preferences in localStorage (keys `localis.*`).
// Storage may be unavailable or throw (private mode, quota, disabled):
// every access falls back to a sane default.

export const STORAGE_KEYS = {
  theme: "localis.theme",
  sidebar: "localis.sidebar",
  onboarded: "localis.onboarded",
  chatConversations: "localis.chat.conversations",
} as const;

export function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(key);
    return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* preferences are best-effort */
  }
}
