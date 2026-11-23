import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../api/client";
import type { AppError, DocumentVersion, Job, LibraryDocument, MediaLink, TranscriptSegment } from "../../api/types";
import { toAppError } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { progressStep } from "../../hooks/useWhisperModels";
import { formatTimestamp } from "../../lib/time";
import { TranscribeDialog } from "../transcription/TranscribeDialog";
import { mediaStatus, whisperLabel } from "./labels";
import { LinkDialog, type LinkDraft } from "./LinkDialog";
import { linkRowId, MediaLinks } from "./MediaLinks";
import { TranscriptPanel } from "./TranscriptPanel";

/** Seconds skipped by ←/→ in the player region. */
export const SEEK_STEP_S = 5;

export interface MediaTarget {
  startMs?: number | null;
  /** Segment index (search result or cited source). */
  unit?: number | null;
}

interface MediaViewerProps {
  doc: LibraryDocument;
  version: DocumentVersion;
  /** Latest transcription job of this version. */
  job: Job | null;
  /** Point to open at; a new object seeks again. */
  target: MediaTarget | null;
  /** Documents of the project (link targets). */
  documents: LibraryDocument[];
  /** Refresh the library (jobs, statuses) after an action. */
  onChanged: () => Promise<void>;
  onRetry?: () => void;
  retrying?: boolean;
  /** Opens the target of a link (page and region). */
  onOpenLink: (link: MediaLink) => void;
}

export function MediaViewer({ doc, version, job, target, documents, onChanged, onRetry, retrying = false, onOpenLink }: MediaViewerProps) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [playError, setPlayError] = useState(false);
  const pendingSeek = useRef<number | null>(null);

  const [segments, setSegments] = useState<TranscriptSegment[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<AppError | null>(null);
  const [transcriptAttempt, setTranscriptAttempt] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const [links, setLinks] = useState<MediaLink[]>([]);
  const [linksError, setLinksError] = useState<AppError | null>(null);
  const [linkDialog, setLinkDialog] = useState<{ link: MediaLink | null; initial: LinkDraft | null } | null>(null);
  const [deletingLink, setDeletingLink] = useState<MediaLink | null>(null);
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [notice, setNotice] = useState("");

  const status = mediaStatus(version, job);
  const transcriptKey = version.transcription?.createdAt ?? null;
  const url = useMemo(() => api.mediaUrl(version.id), [version.id]);
  const isVideo = version.kind === "video";

  // ---- Transcript (reloaded when a new transcription replaces the previous one)
  useEffect(() => {
    setSegments(null);
    setTranscriptError(null);
    if (!transcriptKey) return;
    let alive = true;
    api.getTranscript(version.id).then(
      (items) => alive && setSegments(items),
      (err: unknown) => alive && setTranscriptError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [version.id, transcriptKey, transcriptAttempt]);

  // ---- Links
  const loadLinks = useCallback(async () => {
    try {
      setLinks(await api.listMediaLinks(version.id));
      setLinksError(null);
    } catch (err) {
      setLinksError(toAppError(err));
    }
  }, [version.id]);
  useEffect(() => {
    void loadLinks();
  }, [loadLinks]);

  // ---- Player
  const seek = useCallback((ms: number, play = false) => {
    const el = mediaRef.current;
    const clamped = Math.max(0, ms);
    setCurrentMs(clamped);
    if (!el) return;
    pendingSeek.current = clamped;
    try {
      el.currentTime = clamped / 1000;
    } catch {
      /* applied on loadedmetadata */
    }
    if (play) void el.play()?.catch(() => undefined);
  }, []);

  const targetIndex = useMemo(() => {
    if (!target) return null;
    if (target.unit != null && target.unit > 0) return { index: target.unit };
    if (target.startMs != null && segments) {
      const hit = [...segments].reverse().find((s) => s.startMs <= target.startMs!);
      return hit ? { index: hit.index } : null;
    }
    return null;
    // A new target object (or the transcript arriving) recomputes it.
  }, [target, segments]);

  // Seek to an external target (search result, cited source, backlink).
  useEffect(() => {
    if (!target) return;
    if (target.startMs != null) seek(target.startMs);
  }, [target, seek]);
  useEffect(() => {
    if (!target || target.startMs != null || !targetIndex || !segments) return;
    const segment = segments.find((s) => s.index === targetIndex.index);
    if (segment) seek(segment.startMs);
  }, [target, targetIndex, segments, seek]);

  const onPlayerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Only when the region itself has focus: the native controls handle their own keys.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const el = mediaRef.current;
    if (!el) return;
    if (event.key === " " || event.key === "k") {
      if (el.paused) void el.play()?.catch(() => undefined);
      else el.pause();
    } else if (event.key === "ArrowLeft") {
      seek(el.currentTime * 1000 - SEEK_STEP_S * 1000);
    } else if (event.key === "ArrowRight") {
      const max = version.durationMs ?? Number.POSITIVE_INFINITY;
      seek(Math.min(max, el.currentTime * 1000 + SEEK_STEP_S * 1000));
    } else return;
    event.preventDefault();
  };

  // ---- Transcription job
  const cancelJob = async () => {
    if (!job) return;
    setCancelling(true);
    setActionError(null);
    try {
      await api.cancelJob(job.id);
    } catch (err) {
      setActionError(toAppError(err));
    } finally {
      await onChanged();
      setCancelling(false);
    }
  };

  const running = status.state === "queued" || status.state === "running";
  const announced = status.state === "running" ? `Trascrizione in corso ${progressStep(status.progress) ?? 0} %.` : running ? status.label : "";

  // ---- Selection of segments (interval of a new link)
  const toggleSelected = (index: number) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  const selection: LinkDraft | null = useMemo(() => {
    if (!selected || selected.size === 0 || !segments) return null;
    const chosen = segments.filter((s) => selected.has(s.index));
    if (chosen.length === 0) return null;
    return { startMs: Math.min(...chosen.map((s) => s.startMs)), endMs: Math.max(...chosen.map((s) => s.endMs)) };
  }, [selected, segments]);

  const targets = documents.filter((d) => d.current.kind === "pdf" || d.current.kind === "image");
  const transcriptLabel = `Trascrizione automatica (${whisperLabel(version.transcription?.model ?? "")}) — può contenere errori`;

  let transcriptBody;
  if (transcriptError) {
    transcriptBody = (
      <ErrorBanner error={transcriptError} action={{ label: "Riprova", onClick: () => setTranscriptAttempt((a) => a + 1) }} />
    );
  } else if (transcriptKey && !segments) {
    transcriptBody = (
      <p className="loading" role="status">
        <Spinner />
        Caricamento della trascrizione…
      </p>
    );
  } else if (segments && segments.length > 0) {
    transcriptBody = (
      <TranscriptPanel
        segments={segments}
        label={transcriptLabel}
        durationMs={version.durationMs}
        currentMs={currentMs}
        onSeek={(ms) => seek(ms, true)}
        target={targetIndex}
        selected={selected}
        onToggleSelected={toggleSelected}
      />
    );
  } else {
    transcriptBody = (
      <section className="transcript-panel" aria-label="Trascrizione">
        <h3 className="pane-title">Trascrizione</h3>
        <p className="hint">
          {status.state === "no_speech" || (segments && segments.length === 0)
            ? "Nessun parlato rilevato nella registrazione."
            : running
              ? "Trascrizione in corso: i segmenti appariranno al termine."
              : status.state === "failed"
                ? "Nessuna trascrizione disponibile."
                : "Nessuna trascrizione. «Trascrivi» la crea su questo computer con Whisper."}
        </p>
      </section>
    );
  }

  return (
    <div className="media-viewer">
      <div
        className="media-player"
        role="region"
        tabIndex={0}
        aria-label={`Lettore: ${doc.title}. Spazio riproduce o mette in pausa, frecce sinistra e destra spostano di ${SEEK_STEP_S} secondi.`}
        aria-keyshortcuts="Space ArrowLeft ArrowRight"
        onKeyDown={onPlayerKey}
      >
        {isVideo ? (
          <video
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={url}
            controls
            preload="metadata"
            className="media-element media-video"
            aria-label={doc.title}
            onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            onSeeked={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            onLoadedMetadata={(e) => {
              if (pendingSeek.current != null) e.currentTarget.currentTime = pendingSeek.current / 1000;
            }}
            onError={() => setPlayError(true)}
          />
        ) : (
          <audio
            ref={(el) => {
              mediaRef.current = el;
            }}
            src={url}
            controls
            preload="metadata"
            className="media-element media-audio"
            aria-label={doc.title}
            onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            onSeeked={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            onLoadedMetadata={(e) => {
              if (pendingSeek.current != null) e.currentTarget.currentTime = pendingSeek.current / 1000;
            }}
            onError={() => setPlayError(true)}
          />
        )}
        <p className="hint media-keys" aria-hidden="true">
          Con il lettore selezionato: Spazio riproduci/pausa · ← → {SEEK_STEP_S} secondi
          {version.durationMs != null ? ` · durata ${formatTimestamp(version.durationMs)}` : ""}
        </p>
      </div>
      {playError ? (
        <p className="notice" role="status">
          La registrazione non può essere riprodotta in questa finestra (formato o codifica non supportati dal
          visualizzatore). Il file resta conservato.
        </p>
      ) : null}

      <div className="transcribe-bar">
        {running ? (
          <>
            <span className="transcribe-progress">
              <progress
                max={100}
                value={status.progress ?? undefined}
                aria-label="Avanzamento della trascrizione"
              />
              <span>{status.label}</span>
            </span>
            {job ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void cancelJob()} disabled={cancelling}>
                {cancelling ? <Spinner /> : null}
                Annulla
              </button>
            ) : null}
            {version.transcription ? (
              <span className="hint">La trascrizione attuale resta visibile finché quella nuova non è completa.</span>
            ) : null}
          </>
        ) : (
          <>
            {status.state === "failed" || status.error ? (
              <span className="transcribe-error">
                {status.error ?? "Trascrizione non riuscita."}
                {onRetry ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry} disabled={retrying}>
                    Riprova
                  </button>
                ) : null}
              </span>
            ) : null}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTranscribing(true)}>
              {version.transcription ? "Trascrivi di nuovo" : "Trascrivi"}
            </button>
          </>
        )}
        <span className="visually-hidden" role="status">
          {announced}
        </span>
      </div>
      {actionError ? <ErrorBanner error={actionError} action={{ label: "Chiudi", onClick: () => setActionError(null) }} /> : null}

      <div className="media-columns">
        <div className="media-column">
          {segments && segments.length > 0 ? (
            <div className="selection-bar">
              {selected ? (
                <>
                  <span className="hint" role="status">
                    {selected.size === 1 ? "1 segmento selezionato" : `${selected.size} segmenti selezionati`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!selection}
                    onClick={() => setLinkDialog({ link: null, initial: selection })}
                  >
                    Collega la selezione
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>
                    Fine selezione
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
                  Seleziona segmenti da collegare
                </button>
              )}
            </div>
          ) : null}
          {transcriptBody}
        </div>
        <div className="media-column">
          {linksError ? <ErrorBanner error={linksError} action={{ label: "Riprova", onClick: () => void loadLinks() }} /> : null}
          <MediaLinks
            links={links}
            durationMs={version.durationMs}
            currentMs={currentMs}
            onSeek={(ms) => seek(ms, true)}
            onOpen={onOpenLink}
            onEdit={(link) => setLinkDialog({ link, initial: null })}
            onDelete={setDeletingLink}
            onCreate={() => setLinkDialog({ link: null, initial: selection })}
            canCreate
          />
          <p className="visually-hidden" role="status">
            {notice}
          </p>
        </div>
      </div>

      <TranscribeDialog
        open={transcribing}
        title={doc.title}
        version={version}
        onClose={() => setTranscribing(false)}
        onStarted={() => {
          setTranscribing(false);
          void onChanged();
        }}
      />
      <LinkDialog
        open={linkDialog !== null}
        link={linkDialog?.link ?? null}
        initial={linkDialog?.initial ?? null}
        selection={selection}
        mediaVersionId={version.id}
        mediaTitle={doc.title}
        durationMs={version.durationMs}
        currentMs={() => (mediaRef.current ? mediaRef.current.currentTime * 1000 : currentMs)}
        targets={targets}
        onClose={() => setLinkDialog(null)}
        onSaved={(saved) => {
          const edited = linkDialog?.link != null;
          setLinkDialog(null);
          setSelected(null);
          setNotice(edited ? "Collegamento aggiornato." : "Collegamento creato.");
          void loadLinks().then(() => document.getElementById(linkRowId(saved.id))?.querySelector("button")?.focus());
        }}
      />
      <ConfirmDialog
        open={deletingLink !== null}
        title="Eliminare il collegamento?"
        confirmLabel="Elimina"
        onCancel={() => setDeletingLink(null)}
        onConfirm={async () => {
          if (!deletingLink) return;
          try {
            await api.deleteMediaLink(deletingLink.id);
          } catch (err) {
            if (toAppError(err).code !== "not_found") throw toAppError(err);
          }
          setDeletingLink(null);
          setNotice("Collegamento eliminato.");
          await loadLinks();
        }}
        focusAfterConfirm={() => document.querySelector<HTMLElement>(".media-links .pane-head button")}
      >
        <p>
          Il collegamento tra {deletingLink ? `l'intervallo ${formatTimestamp(deletingLink.startMs)}–${formatTimestamp(deletingLink.endMs)}` : "l'intervallo"}{" "}
          e «{deletingLink?.targetTitle}» verrà rimosso. La registrazione e il documento non vengono toccati.
        </p>
      </ConfirmDialog>
    </div>
  );
}
