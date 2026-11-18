import { useRef, type KeyboardEvent } from "react";
import type { Project } from "../../api/types";

export const optionId = (id: string) => `project-option-${id}`;

interface ProjectListProps {
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** Single-select listbox with roving focus: arrows/Home/End move the selection. */
export function ProjectList({ projects, selectedId, onSelect }: ProjectListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = projects.findIndex((p) => p.id === selectedId);
  const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

  const moveTo = (index: number) => {
    const target = projects[index];
    if (!target) return;
    onSelect(target.id);
    document.getElementById(optionId(target.id))?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const last = projects.length - 1;
    let next: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(focusIndex + 1, last);
        break;
      case "ArrowUp":
        next = Math.max(focusIndex - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next);
  };

  return (
    <ul ref={listRef} className="project-list" role="listbox" aria-label="Elenco progetti" onKeyDown={onKeyDown}>
      {projects.map((project, index) => {
        const selected = project.id === selectedId;
        return (
          <li
            key={project.id}
            id={optionId(project.id)}
            role="option"
            aria-selected={selected}
            tabIndex={index === focusIndex ? 0 : -1}
            className="project-option"
            title={project.name}
            onClick={() => onSelect(project.id)}
          >
            <span className="project-option-name">{project.name}</span>
          </li>
        );
      })}
    </ul>
  );
}
