import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { Project } from "../../api/types";
import { formatDateTime } from "../../lib/format";
import { ProjectCloudSection } from "./ProjectCloudSection";

interface ProjectDetailProps {
  project: Project;
  onDelete: () => void;
  onOpenLibrary: () => void;
  onProjectChange: (project: Project) => void;
}

export function ProjectDetail({ project, onDelete, onOpenLibrary, onProjectChange }: ProjectDetailProps) {
  // Real count from the library; omitted if it cannot be read.
  const [docCount, setDocCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setDocCount(null);
    Promise.resolve()
      .then(() => api.listDocuments(project.id))
      .then(
        (docs) => alive && setDocCount(docs.length),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [project.id]);

  return (
    <section className="detail" aria-labelledby="project-detail-title">
      <div className="detail-head">
        <h2 id="project-detail-title" className="detail-title">
          {project.name}
        </h2>
        <div className="detail-actions">
          <button type="button" className="btn btn-secondary" onClick={onOpenLibrary}>
            Apri libreria
          </button>
          <button type="button" id="delete-project-trigger" className="btn btn-danger-quiet" onClick={onDelete}>
            Elimina
          </button>
        </div>
      </div>
      {project.description ? (
        <p className="detail-description">{project.description}</p>
      ) : (
        <p className="detail-description muted">Nessuna descrizione.</p>
      )}
      <dl className="meta">
        {docCount !== null ? (
          <div>
            <dt>Documenti</dt>
            <dd>{docCount}</dd>
          </div>
        ) : null}
        <div>
          <dt>Creato</dt>
          <dd>
            <time dateTime={project.createdAt}>{formatDateTime(project.createdAt)}</time>
          </dd>
        </div>
        <div>
          <dt>Ultima modifica</dt>
          <dd>
            <time dateTime={project.updatedAt}>{formatDateTime(project.updatedAt)}</time>
          </dd>
        </div>
      </dl>
      <ProjectCloudSection key={project.id} project={project} onChange={onProjectChange} />
    </section>
  );
}
