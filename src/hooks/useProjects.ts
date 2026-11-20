import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { AppError, NewProjectInput, Project } from "../api/types";
import { toAppError } from "../api/types";

export type LoadStatus = "loading" | "ready" | "error";

export interface ProjectsStore {
  status: LoadStatus;
  loadError: AppError | null;
  projects: Project[];
  reload: () => void;
  /** Creates a project; resolves with it or rejects with an AppError. */
  create: (input: NewProjectInput) => Promise<Project>;
  /** Deletes a project; rejects with an AppError. */
  remove: (id: string) => Promise<void>;
  /** Replaces a project changed by another command (e.g. its cloud policy). */
  replace: (project: Project) => void;
}

const byUpdatedDesc = (a: Project, b: Project) => b.updatedAt.localeCompare(a.updatedAt);

export function useProjects(): ProjectsStore {
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const requestId = useRef(0);

  const reload = useCallback(() => {
    const id = ++requestId.current;
    setStatus("loading");
    setLoadError(null);
    api.listProjects().then(
      (items) => {
        if (id !== requestId.current) return;
        setProjects(items);
        setStatus("ready");
      },
      (err: unknown) => {
        if (id !== requestId.current) return;
        setLoadError(toAppError(err));
        setStatus("error");
      },
    );
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const create = useCallback(async (input: NewProjectInput) => {
    try {
      const project = await api.createProject(input);
      setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)].sort(byUpdatedDesc));
      return project;
    } catch (err) {
      throw toAppError(err);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await api.deleteProject(id);
    } catch (err) {
      const error = toAppError(err);
      // Already gone in the backend: reflect that in the list too.
      if (error.code === "not_found") setProjects((prev) => prev.filter((p) => p.id !== id));
      throw error;
    }
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const replace = useCallback((project: Project) => {
    setProjects((prev) => prev.map((p) => (p.id === project.id ? project : p)));
  }, []);

  return { status, loadError, projects, reload, create, remove, replace };
}
