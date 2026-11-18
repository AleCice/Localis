// The only module that talks to the backend. Components import from here.
// Owner: main agent.
import { invoke } from "@tauri-apps/api/core";
import type { NewProjectInput, Project } from "./types";
import { toAppError } from "./types";
import { mockBackend } from "./mock";

export interface Api {
  listProjects(): Promise<Project[]>;
  createProject(input: NewProjectInput): Promise<Project>;
  deleteProject(id: string): Promise<void>;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw {
      code: "internal",
      message: "Localis va avviato come app desktop.",
      detail: "Tauri runtime not detected (use `npm run tauri dev`, or `npm run dev:mock` for UI work).",
    };
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw toAppError(err);
  }
}

const tauriApi: Api = {
  listProjects: () => call<Project[]>("list_projects"),
  createProject: (input) => call<Project>("create_project", { input }),
  deleteProject: (id) => call<void>("delete_project", { id }),
};

// The in-memory mock exists only for UI development and browser tests
// (`npm run dev:mock`); it is never used in the desktop app or production builds.
const useMock = import.meta.env.DEV && import.meta.env.VITE_API_MOCK === "1";

export const api: Api = useMock ? mockBackend : tauriApi;
