import type { DocumentKind, DocumentVersion, Job, TextStatus, TranscriptionLanguage, WhisperModelId } from "../../api/types";

export const KIND_LABEL: Record<DocumentKind, string> = {
  pdf: "PDF",
  text: "Testo",
  markdown: "Markdown",
  docx: "Word",
  image: "Immagine",
  audio: "Audio",
  video: "Video",
};

/** Extensions accepted for a new version of a document of the given kind. */
export const KIND_ACCEPT: Record<DocumentKind, string> = {
  pdf: ".pdf",
  text: ".txt",
  markdown: ".md,.markdown",
  docx: ".docx",
  image: ".png,.jpg,.jpeg,.gif,.webp",
  audio: ".mp3,.m4a,.wav",
  video: ".mp4",
};

export const isMediaKind = (kind: DocumentKind) => kind === "audio" || kind === "video";

export const STATUS_LABEL: Record<TextStatus, string> = {
  pending: "Estrazione in corso…",
  extracted: "Ricercabile",
  no_text: "Senza testo ricercabile",
  failed: "Estrazione non riuscita",
  not_applicable: "Non ricercabile",
};

/** Longer, plain explanation used as tooltip and in the viewer. */
export const STATUS_EXPLANATION: Record<TextStatus, string> = {
  pending: "Localis sta estraendo il testo per la ricerca.",
  extracted: "Il testo è stato estratto ed è incluso nella ricerca.",
  no_text:
    "Il file non contiene testo selezionabile (ad esempio un PDF scansionato). Il riconoscimento del testo (OCR) non è disponibile.",
  failed: "Non è stato possibile estrarre il testo. Il file resta consultabile.",
  not_applicable: "Le immagini non sono incluse nella ricerca.",
};

// ---------------------------------------------------------------- v0.5 transcription

export const MODEL_SHORT: Record<WhisperModelId, string> = {
  tiny: "tiny",
  base: "base",
  small: "small",
  "large-v3-turbo-q5": "large-v3-turbo",
};

export function whisperLabel(model: WhisperModelId | string): string {
  return `Whisper ${MODEL_SHORT[model as WhisperModelId] ?? model}`;
}

export const LANGUAGE_OPTIONS: { value: TranscriptionLanguage; label: string }[] = [
  { value: "auto", label: "Rilevamento automatico" },
  { value: "it", label: "Italiano" },
  { value: "en", label: "Inglese" },
  { value: "fr", label: "Francese" },
  { value: "de", label: "Tedesco" },
  { value: "es", label: "Spagnolo" },
];

const LANGUAGE_NAME: Record<string, string> = {
  it: "italiano",
  en: "inglese",
  fr: "francese",
  de: "tedesco",
  es: "spagnolo",
};

export function languageName(code: string): string {
  return LANGUAGE_NAME[code] ?? code;
}

/** Latest transcription job of a version (jobs are listed newest first, but do not rely on it). */
export function latestTranscribeJob(jobs: Job[], versionId: string): Job | null {
  let latest: Job | null = null;
  for (const job of jobs) {
    if (job.kind !== "transcribe" || job.versionId !== versionId) continue;
    if (!latest || job.id > latest.id) latest = job;
  }
  return latest;
}

export type MediaState = "untranscribed" | "queued" | "running" | "done" | "no_speech" | "failed";

export interface MediaStatus {
  state: MediaState;
  label: string;
  /** 0–100 while running, when known. */
  progress: number | null;
  /** Failure message of the last attempt. */
  error: string | null;
}

/**
 * Honest transcription state of an audio/video version, from its text status and its latest
 * transcription job. A running job wins (also over an existing transcript being replaced).
 */
export function mediaStatus(version: DocumentVersion, job: Job | null): MediaStatus {
  if (job && job.state === "queued") return { state: "queued", label: "Trascrizione in coda", progress: null, error: null };
  if (job && job.state === "running") {
    const progress = job.progress != null ? Math.max(0, Math.min(100, Math.round(job.progress))) : null;
    return {
      state: "running",
      label: progress != null ? `Trascrizione in corso ${progress} %` : "Trascrizione in corso",
      progress,
      error: null,
    };
  }
  const failedError = job && job.state === "failed" ? (job.error ?? "Trascrizione non riuscita.") : null;
  if (version.textStatus === "pending")
    return { state: "queued", label: "Trascrizione in coda", progress: null, error: null };
  if (version.textStatus === "failed")
    return { state: "failed", label: "Trascrizione non riuscita", progress: null, error: failedError };
  if (version.textStatus === "no_text")
    return { state: "no_speech", label: "Nessun parlato rilevato", progress: null, error: null };
  if (version.textStatus === "extracted")
    return {
      state: "done",
      label: version.transcription ? `Trascritta (${whisperLabel(version.transcription.model)})` : "Trascritta",
      progress: null,
      error: failedError,
    };
  // not_applicable after a failed job = the user cancelled it (the backend marks real failures
  // `failed`): still to transcribe, with the job's message available to the viewer.
  return { state: "untranscribed", label: "Da trascrivere", progress: null, error: failedError };
}
