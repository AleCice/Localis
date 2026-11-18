// In-memory backend for UI development and browser tests only (npm run dev:mock).
// Mirrors backend validation so the UI can be exercised without Tauri.
// Data lives in sessionStorage so a page reload keeps it within the tab.
import type { AppError, NewProjectInput, Project } from "./types";
import { DESCRIPTION_MAX, NAME_MAX } from "./types";
import type { Api } from "./client";

const KEY = "localis.mock.projects";

function load(): Project[] {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? "[]") as Project[];
  } catch {
    return [];
  }
}

function save(items: Project[]) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

function fail(e: AppError): never {
  throw e;
}

const delay = () => new Promise((r) => setTimeout(r, 150));

export const mockBackend: Api = {
  async listProjects() {
    await delay();
    return load().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },
  async createProject(input: NewProjectInput) {
    await delay();
    const name = input.name.trim();
    const description = input.description?.trim() || null;
    if (!name) fail({ code: "validation", field: "name", message: "Inserisci un nome." });
    if ([...name].length > NAME_MAX)
      fail({ code: "validation", field: "name", message: `Il nome può avere al massimo ${NAME_MAX} caratteri.` });
    if (description && [...description].length > DESCRIPTION_MAX)
      fail({
        code: "validation",
        field: "description",
        message: `La descrizione può avere al massimo ${DESCRIPTION_MAX} caratteri.`,
      });
    const items = load();
    if (items.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      fail({ code: "duplicate", field: "name", message: "Esiste già un progetto con questo nome." });
    const now = new Date().toISOString();
    const project: Project = { id: crypto.randomUUID(), name, description, createdAt: now, updatedAt: now };
    save([project, ...items]);
    return project;
  },
  async deleteProject(id: string) {
    await delay();
    const items = load();
    if (!items.some((p) => p.id === id))
      fail({ code: "not_found", message: "Il progetto non esiste più." });
    save(items.filter((p) => p.id !== id));
  },
};
