import { useCallback, useEffect, useState } from "react";
import { readPref, STORAGE_KEYS, writePref } from "../lib/storage";
import { useMediaQuery } from "./useMediaQuery";

export const THEME_PREFS = ["system", "light", "dark"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

/**
 * Theme preference. index.html applies the stored theme before first paint;
 * this hook keeps `data-theme` in sync afterwards, following the OS live
 * when the preference is "system".
 */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPrefState] = useState<ThemePref>(() => readPref(STORAGE_KEYS.theme, THEME_PREFS, "system"));
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    writePref(STORAGE_KEYS.theme, next);
  }, []);

  return [pref, setPref];
}
