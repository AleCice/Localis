import type { UnitKind } from "../api/types";

/** A request to open a document of the selected project in the Library at a given point. */
export interface LibraryLink {
  documentId: string;
  /** The version the passage comes from (may be an older one). */
  versionId: string;
  unit: number;
  unitKind: UnitKind;
  /** v0.5: start of the transcript segment (unitKind "segment"): opens the player there. */
  startMs?: number | null;
  /** Passage text to show next to the document (e.g. a cited source). */
  snippet: string | null;
  /** Changes on every request, so opening the same source twice jumps again. */
  nonce: number;
}
