// Contract between the React frontend and the Tauri backend (v0.1).
// Owner: main agent. Mirrors the serde types in src-tauri/src/commands.rs.

export interface Project {
  id: string; // UUID v4
  name: string;
  description: string | null;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
}

export interface NewProjectInput {
  name: string;
  description?: string | null;
}

export type AppErrorCode = "validation" | "duplicate" | "not_found" | "storage" | "internal";

export interface AppError {
  code: AppErrorCode;
  /** Short, user-facing message in Italian. */
  message: string;
  /** Field concerned, for validation/duplicate errors ("name" | "description"). */
  field?: string;
  /** Technical diagnostics: never shown in the normal UI, only in an expandable detail. */
  detail?: string;
}

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 2000;

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AppError).code === "string" &&
    typeof (value as AppError).message === "string"
  );
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return {
    code: "internal",
    message: "Si è verificato un errore imprevisto.",
    detail: err instanceof Error ? err.message : String(err),
  };
}
