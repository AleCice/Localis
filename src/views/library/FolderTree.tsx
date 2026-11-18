import { useEffect, useMemo, useState } from "react";
import type { Folder } from "../../api/types";
import { CaretIcon, FolderIcon } from "../../components/Icons";
import { childrenByParent, folderPath } from "./folders";

export const folderNodeId = (id: string | null) => `folder-node-${id ?? "root"}`;

interface FolderTreeProps {
  rootLabel: string;
  folders: Folder[];
  currentId: string | null;
  onSelect: (id: string | null) => void;
  /** Document count per folder id ("" = root), shown discreetly. */
  counts: Map<string, number>;
}

/**
 * Folder navigation as nested lists of buttons: each folder is a button
 * (aria-current marks the open one) with an optional expand/collapse toggle.
 * Simple and robust with any assistive technology; Tab moves through it.
 */
export function FolderTree({ rootLabel, folders, currentId, onSelect, counts }: FolderTreeProps) {
  const children = useMemo(() => childrenByParent(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Keep the open folder visible: expand its ancestors.
  useEffect(() => {
    const ancestors = folderPath(folders, currentId).slice(0, -1);
    if (ancestors.length === 0) return;
    setExpanded((prev) => {
      if (ancestors.every((f) => prev.has(f.id))) return prev;
      const next = new Set(prev);
      for (const f of ancestors) next.add(f.id);
      return next;
    });
  }, [folders, currentId]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderLevel = (parent: string, seen: Set<string>) => {
    const items = (children.get(parent) ?? []).filter((f) => !seen.has(f.id));
    if (items.length === 0) return null;
    return (
      <ul className="tree-group">
        {items.map((folder) => {
          const sub = children.get(folder.id) ?? [];
          const isOpen = expanded.has(folder.id);
          const nextSeen = new Set(seen).add(folder.id);
          const count = counts.get(folder.id) ?? 0;
          return (
            <li key={folder.id}>
              <div className="tree-row">
                {sub.length > 0 ? (
                  <button
                    type="button"
                    className="tree-toggle"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? "Comprimi" : "Espandi"} «${folder.name}»`}
                    onClick={() => toggle(folder.id)}
                  >
                    <CaretIcon open={isOpen} />
                  </button>
                ) : (
                  <span className="tree-toggle-spacer" aria-hidden="true" />
                )}
                <button
                  type="button"
                  id={folderNodeId(folder.id)}
                  className="tree-item"
                  aria-current={folder.id === currentId ? "true" : undefined}
                  title={folder.name}
                  onClick={() => onSelect(folder.id)}
                >
                  <FolderIcon />
                  <span className="tree-label">{folder.name}</span>
                  {count > 0 ? (
                    <span className="tree-count" aria-hidden="true">
                      {count}
                    </span>
                  ) : null}
                </button>
              </div>
              {isOpen ? renderLevel(folder.id, nextSeen) : null}
            </li>
          );
        })}
      </ul>
    );
  };

  const rootCount = counts.get("") ?? 0;
  return (
    <nav className="tree" aria-label="Cartelle">
      <ul className="tree-group tree-root">
        <li>
          <div className="tree-row">
            <span className="tree-toggle-spacer" aria-hidden="true" />
            <button
              type="button"
              id={folderNodeId(null)}
              className="tree-item"
              aria-current={currentId === null ? "true" : undefined}
              title={rootLabel}
              onClick={() => onSelect(null)}
            >
              <FolderIcon />
              <span className="tree-label">{rootLabel}</span>
              {rootCount > 0 ? (
                <span className="tree-count" aria-hidden="true">
                  {rootCount}
                </span>
              ) : null}
            </button>
          </div>
          {renderLevel("", new Set())}
        </li>
      </ul>
    </nav>
  );
}
