import type { Folder } from "../../api/types";

const collator = new Intl.Collator("it", { sensitivity: "base", numeric: true });

/** Children of each folder id ("" = project root), sorted by name. */
export function childrenByParent(folders: Folder[]): Map<string, Folder[]> {
  const map = new Map<string, Folder[]>();
  for (const folder of folders) {
    const key = folder.parentId ?? "";
    const list = map.get(key);
    if (list) list.push(folder);
    else map.set(key, [folder]);
  }
  for (const list of map.values()) list.sort((a, b) => collator.compare(a.name, b.name));
  return map;
}

/** Ancestors of a folder, from the outermost to the folder itself. */
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: Folder[] = [];
  const seen = new Set<string>();
  let current = id ? byId.get(id) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** Depth-first flattening for pickers: [{folder, depth}]. */
export function flattenFolders(folders: Folder[]): { folder: Folder; depth: number }[] {
  const children = childrenByParent(folders);
  const out: { folder: Folder; depth: number }[] = [];
  const visit = (parent: string, depth: number, seen: Set<string>) => {
    for (const folder of children.get(parent) ?? []) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      out.push({ folder, depth });
      visit(folder.id, depth + 1, seen);
    }
  };
  visit("", 0, new Set());
  return out;
}
