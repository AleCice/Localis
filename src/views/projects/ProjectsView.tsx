import { useEffect, useState, type ReactNode } from "react";
import type { AppError, Project } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { PlusIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import type { ProjectsStore } from "../../hooks/useProjects";
import { CreateProjectDialog } from "./CreateProjectDialog";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { Onboarding } from "./Onboarding";
import { ProjectDetail } from "./ProjectDetail";
import { ProjectList } from "./ProjectList";

const EMPTY_NEW_ID = "empty-new-project";
const HEADER_NEW_ID = "header-new-project";

interface ProjectsViewProps {
  store: ProjectsStore;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onboarded: boolean;
  onOnboarded: () => void;
  sidebarToggle: ReactNode;
}

export function ProjectsView({ store, selectedId, onSelect, onboarded, onOnboarded, sidebarToggle }: ProjectsViewProps) {
  const { status, loadError, projects } = store;
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Project | null>(null);
  const [notice, setNotice] = useState<AppError | null>(null);
  const showLoading = useDelayedFlag(status === "loading");

  // Fall back to the first project when nothing (valid) is selected.
  const selected = projects.find((p) => p.id === selectedId) ?? projects[0] ?? null;

  // Existing projects mean the user is past onboarding.
  useEffect(() => {
    if (status === "ready" && projects.length > 0 && !onboarded) onOnboarded();
  }, [status, projects.length, onboarded, onOnboarded]);

  const confirmDelete = async (project: Project) => {
    const index = projects.findIndex((p) => p.id === project.id);
    const remaining = projects.filter((p) => p.id !== project.id);
    const next = remaining[index] ?? remaining[index - 1] ?? null;
    try {
      await store.remove(project.id);
      setNotice(null);
    } catch (err) {
      const error = err as AppError;
      if (error.code !== "not_found") throw error;
      // Already gone: same outcome as a deletion, but tell the user.
      setNotice(error);
    }
    onSelect(next?.id ?? null);
    setDeleting(null);
  };

  const focusAfterDelete = () => {
    const current = document.querySelector<HTMLElement>('.project-option[tabindex="0"]');
    return current ?? document.getElementById(EMPTY_NEW_ID);
  };

  const showOnboarding = status === "ready" && projects.length === 0 && !onboarded;
  const isEmpty = status === "ready" && projects.length === 0;

  return (
    <div className={showOnboarding ? "view view-onboarding" : "view"}>
      <div className="view-header">
        {sidebarToggle}
        {showOnboarding ? null : <h1 className="view-title">Progetti</h1>}
        {status === "ready" && !isEmpty ? (
          <button type="button" id={HEADER_NEW_ID} className="btn btn-primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            Nuovo progetto
          </button>
        ) : null}
      </div>

      {showOnboarding ? (
        <Onboarding
          onStart={() => {
            onOnboarded();
            setCreating(true);
          }}
          onSkip={onOnboarded}
        />
      ) : (
        <div className="view-content">
          {notice ? <ErrorBanner error={notice} action={{ label: "Chiudi", onClick: () => setNotice(null) }} /> : null}

          {status === "loading" && showLoading ? (
            <p className="loading" role="status">
              <Spinner />
              Caricamento…
            </p>
          ) : null}

          {status === "error" && loadError ? (
            <ErrorBanner error={loadError} action={{ label: "Riprova", onClick: store.reload }} />
          ) : null}

          {isEmpty ? (
            <div className="empty">
              <p>Nessun progetto. Un progetto può essere un corso, una tesi o una ricerca.</p>
              <button type="button" id={EMPTY_NEW_ID} className="btn btn-primary" onClick={() => setCreating(true)}>
                <PlusIcon />
                Nuovo progetto
              </button>
            </div>
          ) : null}

          {status === "ready" && !isEmpty ? (
            <div className="projects">
              <div className="projects-list-pane">
                <ProjectList projects={projects} selectedId={selected?.id ?? null} onSelect={onSelect} />
              </div>
              <div className="projects-detail-pane">
                {selected ? <ProjectDetail project={selected} onDelete={() => setDeleting(selected)} /> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}

      <CreateProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSubmit={store.create}
        onCreated={(project) => {
          onSelect(project.id);
          setCreating(false);
        }}
        fallbackFocus={() => document.getElementById(EMPTY_NEW_ID) ?? document.getElementById(HEADER_NEW_ID)}
      />
      <DeleteProjectDialog
        project={deleting}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
        focusAfterDelete={focusAfterDelete}
      />
    </div>
  );
}
