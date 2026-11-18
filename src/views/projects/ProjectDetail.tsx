import type { Project } from "../../api/types";
import { formatDateTime } from "../../lib/format";

interface ProjectDetailProps {
  project: Project;
  onDelete: () => void;
}

export function ProjectDetail({ project, onDelete }: ProjectDetailProps) {
  return (
    <section className="detail" aria-labelledby="project-detail-title">
      <div className="detail-head">
        <h2 id="project-detail-title" className="detail-title">
          {project.name}
        </h2>
        <button type="button" id="delete-project-trigger" className="btn btn-danger-quiet" onClick={onDelete}>
          Elimina
        </button>
      </div>
      {project.description ? (
        <p className="detail-description">{project.description}</p>
      ) : (
        <p className="detail-description muted">Nessuna descrizione.</p>
      )}
      <dl className="meta">
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
    </section>
  );
}
