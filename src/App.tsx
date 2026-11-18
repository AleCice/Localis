import { useCallback, useEffect, useState } from "react";
import { SidebarIcon } from "./components/Icons";
import { Sidebar, type SidebarDisplay, type ViewId } from "./components/Sidebar";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useProjects } from "./hooks/useProjects";
import { useTheme } from "./hooks/useTheme";
import { readPref, STORAGE_KEYS, writePref } from "./lib/storage";
import { LibraryView } from "./views/library/LibraryView";
import { ProjectsView } from "./views/projects/ProjectsView";
import { SettingsView } from "./views/SettingsView";

const SIDEBAR_PREFS = ["expanded", "collapsed", "hidden"] as const;
type SidebarPref = (typeof SIDEBAR_PREFS)[number];
const SIDEBAR_ID = "app-sidebar";

/**
 * Below this width an expanded sidebar would squeeze the content, so it shows
 * icons only and expands as an overlay on demand. Expressed in rem so it
 * follows the zoom level and the font size.
 */
const NARROW_QUERY = "(max-width: 44rem)";

export function App() {
  const [view, setView] = useState<ViewId>("projects");
  const [theme, setTheme] = useTheme();
  const store = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Same fallback as the Projects view: the first project when nothing (valid) is selected.
  const selectedProject = store.projects.find((p) => p.id === selectedId) ?? store.projects[0] ?? null;
  const [onboarded, setOnboardedState] = useState(
    () => readPref(STORAGE_KEYS.onboarded, ["true", "false"] as const, "false") === "true",
  );

  const [sidebarPref, setSidebarPrefState] = useState<SidebarPref>(() =>
    readPref(STORAGE_KEYS.sidebar, SIDEBAR_PREFS, "expanded"),
  );
  const [overlayOpen, setOverlayOpen] = useState(false);
  const narrow = useMediaQuery(NARROW_QUERY);

  const setSidebarPref = (pref: SidebarPref) => {
    setSidebarPrefState(pref);
    writePref(STORAGE_KEYS.sidebar, pref);
  };

  const display: SidebarDisplay =
    sidebarPref === "hidden" ? "hidden" : narrow ? (overlayOpen ? "overlay" : "collapsed") : sidebarPref;

  useEffect(() => {
    if (!narrow) setOverlayOpen(false);
  }, [narrow]);

  // Esc closes the overlay sidebar (dialogs handle their own Esc).
  useEffect(() => {
    if (display !== "overlay") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setOverlayOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [display]);

  // A file dropped outside a drop target must not make the webview navigate to it.
  useEffect(() => {
    const guard = (event: DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, []);

  const markOnboarded = useCallback(() => {
    setOnboardedState(true);
    writePref(STORAGE_KEYS.onboarded, "true");
  }, []);

  const toggleLabels = () => {
    if (narrow) setOverlayOpen((open) => !open);
    else setSidebarPref(sidebarPref === "expanded" ? "collapsed" : "expanded");
  };

  const sidebarVisible = display !== "hidden";
  const sidebarToggle = (
    <button
      type="button"
      className="icon-btn"
      aria-controls={SIDEBAR_ID}
      aria-expanded={sidebarVisible}
      aria-label={sidebarVisible ? "Nascondi barra laterale" : "Mostra barra laterale"}
      title={sidebarVisible ? "Nascondi barra laterale" : "Mostra barra laterale"}
      onClick={() => {
        setOverlayOpen(false);
        setSidebarPref(sidebarVisible ? "hidden" : "expanded");
      }}
    >
      <SidebarIcon />
    </button>
  );

  return (
    <div className="app" data-sidebar={display}>
      <Sidebar
        id={SIDEBAR_ID}
        display={display}
        view={view}
        onNavigate={(next) => {
          setView(next);
          setOverlayOpen(false);
        }}
        onToggleLabels={toggleLabels}
      />
      {display === "overlay" ? (
        <div className="sidebar-scrim" aria-hidden="true" onClick={() => setOverlayOpen(false)} />
      ) : null}
      <main className="main">
        {view === "projects" ? (
          <ProjectsView
            store={store}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onboarded={onboarded}
            onOnboarded={markOnboarded}
            sidebarToggle={sidebarToggle}
            onOpenLibrary={() => {
              if (selectedProject) setSelectedId(selectedProject.id);
              setView("library");
            }}
          />
        ) : view === "library" ? (
          <LibraryView
            project={selectedProject}
            projectsStatus={store.status}
            onGoToProjects={() => setView("projects")}
            sidebarToggle={sidebarToggle}
          />
        ) : (
          <SettingsView theme={theme} onThemeChange={setTheme} sidebarToggle={sidebarToggle} />
        )}
      </main>
    </div>
  );
}
