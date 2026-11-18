import type { ReactNode } from "react";
import type { ThemePref } from "../hooks/useTheme";

interface SettingsViewProps {
  theme: ThemePref;
  onThemeChange: (theme: ThemePref) => void;
  sidebarToggle: ReactNode;
}

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "Sistema" },
  { value: "light", label: "Chiaro" },
  { value: "dark", label: "Scuro" },
];

export function SettingsView({ theme, onThemeChange, sidebarToggle }: SettingsViewProps) {
  return (
    <div className="view">
      <div className="view-header">
        {sidebarToggle}
        <h1 className="view-title">Impostazioni</h1>
      </div>
      <div className="view-content settings">
        <fieldset className="settings-group">
          <legend>Tema</legend>
          <div className="segmented">
            {OPTIONS.map((option) => (
              <label key={option.value} className="segmented-option">
                <input
                  type="radio"
                  name="theme"
                  value={option.value}
                  checked={theme === option.value}
                  onChange={() => onThemeChange(option.value)}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <p className="hint">«Sistema» segue l'aspetto chiaro o scuro del sistema operativo.</p>
        </fieldset>
      </div>
    </div>
  );
}
