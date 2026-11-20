import type { ReactNode } from "react";
import type { Project } from "../api/types";
import type { ThemePref } from "../hooks/useTheme";
import { CloudStoreProvider } from "../hooks/useCloud";
import { useLlm } from "../hooks/useLlm";
import { CloudActivitySection } from "./settings/CloudActivitySection";
import { CloudProvidersSection } from "./settings/CloudProvidersSection";
import { LmStudioSection } from "./settings/LmStudioSection";
import { ModelsSection } from "./settings/ModelsSection";
import { PricesSection } from "./settings/PricesSection";

interface SettingsViewProps {
  theme: ThemePref;
  onThemeChange: (theme: ThemePref) => void;
  sidebarToggle: ReactNode;
  /** Selected project, for the indexing status. */
  project: Project | null;
}

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "Sistema" },
  { value: "light", label: "Chiaro" },
  { value: "dark", label: "Scuro" },
];

export function SettingsView({ theme, onThemeChange, sidebarToggle, project }: SettingsViewProps) {
  const llm = useLlm();
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
        <CloudStoreProvider>
          <LmStudioSection llm={llm} />
          <CloudProvidersSection />
          <PricesSection />
          <ModelsSection llm={llm} project={project} />
          <CloudActivitySection />
        </CloudStoreProvider>
      </div>
    </div>
  );
}
