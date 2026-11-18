import type { Project } from "../api/types";

let counter = 0;

/** Synthetic project fixture. */
export function makeProject(name: string, overrides: Partial<Project> = {}): Project {
  counter += 1;
  const stamp = new Date(Date.UTC(2026, 2, 10, 9, 0, counter)).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name,
    description: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}
