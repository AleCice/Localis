import type { ReactNode } from "react";
import { BooksIcon, ChatIcon, ChevronIcon, FolderIcon, SettingsIcon } from "./Icons";

export type ViewId = "projects" | "library" | "settings";

/** How the sidebar is drawn right now. "overlay" is the expanded sidebar over narrow content. */
export type SidebarDisplay = "expanded" | "collapsed" | "overlay" | "hidden";

interface SidebarProps {
  id: string;
  display: SidebarDisplay;
  view: ViewId;
  onNavigate: (view: ViewId) => void;
  onToggleLabels: () => void;
}

interface NavEntry {
  label: string;
  icon: ReactNode;
  view?: ViewId;
}

const ENTRIES: NavEntry[] = [
  { label: "Progetti", icon: <FolderIcon />, view: "projects" },
  { label: "Libreria", icon: <BooksIcon />, view: "library" },
  { label: "Chat", icon: <ChatIcon /> },
  { label: "Impostazioni", icon: <SettingsIcon />, view: "settings" },
];

const UNAVAILABLE_HINT_ID = "nav-unavailable-hint";

export function Sidebar({ id, display, view, onNavigate, onToggleLabels }: SidebarProps) {
  const showLabels = display === "expanded" || display === "overlay";
  return (
    <aside id={id} className="sidebar" data-display={display} hidden={display === "hidden"}>
      <div className="sidebar-head">
        <span className="brand" aria-hidden={!showLabels}>
          <svg className="brand-mark" viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
            <rect x="64" y="64" width="896" height="896" rx="208" fill="var(--brand)" />
            <path
              d="M360 280v400h300"
              fill="none"
              stroke="#fff"
              strokeWidth="96"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="660" cy="360" r="64" fill="#a9c8e8" />
          </svg>
          <span className="brand-name">Localis</span>
        </span>
        <button
          type="button"
          className="icon-btn sidebar-labels-toggle"
          aria-controls={id}
          aria-expanded={showLabels}
          aria-label={showLabels ? "Comprimi barra laterale" : "Espandi barra laterale"}
          title={showLabels ? "Comprimi barra laterale" : "Espandi barra laterale"}
          onClick={onToggleLabels}
        >
          <ChevronIcon direction={showLabels ? "left" : "right"} />
        </button>
      </div>

      <nav aria-label="Principale">
        <ul className="nav-list">
          {ENTRIES.map((entry) => {
            const available = entry.view !== undefined;
            const current = available && entry.view === view;
            return (
              <li key={entry.label}>
                <button
                  type="button"
                  className="nav-item"
                  aria-current={current ? "page" : undefined}
                  aria-disabled={available ? undefined : true}
                  aria-describedby={available ? undefined : UNAVAILABLE_HINT_ID}
                  title={available ? (showLabels ? undefined : entry.label) : `${entry.label} · Disponibile in una versione futura`}
                  onClick={() => {
                    if (entry.view) onNavigate(entry.view);
                  }}
                >
                  {entry.icon}
                  <span className="nav-label">{entry.label}</span>
                  {!available ? (
                    <span className="nav-hint" aria-hidden="true">
                      Presto
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
        <span id={UNAVAILABLE_HINT_ID} className="visually-hidden">
          Disponibile in una versione futura
        </span>
      </nav>
    </aside>
  );
}
