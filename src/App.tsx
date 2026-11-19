import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SidebarIcon } from "./components/Icons";
import { Sidebar, type SidebarDisplay, type ViewId } from "./components/Sidebar";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { useProjects } from "./hooks/useProjects";
import { useTheme } from "./hooks/useTheme";
import type { LibraryLink } from "./lib/navigation";
import { readPref, STORAGE_KEYS, writePref } from "./lib/storage";
import { LibraryView } from "./views/library/LibraryView";
import { ProjectsView } from "./views/projects/ProjectsView";
import { SettingsView } from "./views/SettingsView";

// The chat (Markdown, KaTeX) is a separate chunk loaded on first use.
const ChatView = lazy(() => import("./views/chat/ChatView").then((m) => ({ default: m.ChatView })));

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
  // The chat stays mounted once opened, so an answer keeps streaming while the user checks a source.
  const [chatVisited, setChatVisited] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [libraryLink, setLibraryLink] = useState<LibraryLink | null>(null);
  const linkNonce = useRef(0);
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

  useEffect(() => {
    if (view === "chat") setChatVisited(true);
  }, [view]);

  const openSource = useCallback((link: Omit<LibraryLink, "nonce">) => {
    linkNonce.current += 1;
    setLibraryLink({ ...link, nonce: linkNonce.current });
    setView("library");
  }, []);

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
            link={libraryLink}
            onLinkHandled={() => setLibraryLink(null)}
            onBackToChat={chatVisited ? () => setView("chat") : undefined}
          />
        ) : view === "settings" ? (
          <SettingsView
            theme={theme}
            onThemeChange={setTheme}
            sidebarToggle={sidebarToggle}
            project={selectedProject}
          />
        ) : null}
        {chatVisited || view === "chat" ? (
          <div className="view-slot" hidden={view !== "chat"}>
            <Suspense fallback={null}>
              <ChatView
                project={selectedProject}
                projectsStatus={store.status}
                onGoToProjects={() => setView("projects")}
                sidebarToggle={sidebarToggle}
                conversationId={conversationId}
                onConversationChange={setConversationId}
                onOpenSource={openSource}
                onOpenSettings={() => setView("settings")}
                active={view === "chat"}
              />
            </Suspense>
          </div>
        ) : null}
      </main>
    </div>
  );
}
