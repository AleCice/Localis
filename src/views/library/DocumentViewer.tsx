import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { api } from "../../api/client";
import type { AppError, DocumentVersion, LibraryDocument } from "../../api/types";
import { IMPORT_MAX_BYTES, toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ArrowLeftIcon, CloseIcon, CopyIcon, InfoIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { formatBytes, formatDateTime } from "../../lib/format";
import { ImageViewer } from "./ImageViewer";
import { KIND_ACCEPT, KIND_LABEL, STATUS_EXPLANATION } from "./labels";
import { StatusLabel } from "./StatusLabel";
import { TextViewer } from "./TextViewer";

// The PDF viewer is a separate chunk together with pdf.js.
const PdfViewer = lazy(() => import("./PdfViewer").then((m) => ({ default: m.PdfViewer })));

export interface ViewerTarget {
  unit: number;
  unitKind: "page" | "block";
  /** Version the target refers to (default: the current one). */
  versionId?: string;
  /** Passage to show next to the document (a source cited in the chat). */
  snippet?: string | null;
}

interface DocumentViewerProps {
  doc: LibraryDocument;
  folderLabel: string;
  target: ViewerTarget | null;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onMove: () => void;
  onDelete: () => void;
  /** After a new version was uploaded: refresh the library. */
  onChanged: () => Promise<void>;
  /** Present in the narrow (stacked) layout. */
  onBack?: () => void;
  /** Present when the chat is open in the background. */
  onBackToChat?: () => void;
  /** Hides the cited passage. */
  onDismissTarget?: () => void;
}

export const VIEWER_HEADING_ID = "viewer-title";

export function tooLargeError(): AppError {
  return {
    code: "too_large",
    message: `Il file supera il limite di ${formatBytes(IMPORT_MAX_BYTES)}.`,
  };
}

function shortHash(sha: string) {
  return sha.length > 16 ? `${sha.slice(0, 8)}…${sha.slice(-8)}` : sha;
}

/** Loads the original bytes of a version (PDF and images are rendered from them). */
function useOriginal(version: DocumentVersion) {
  const needsBytes = version.kind === "pdf" || version.kind === "image";
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setData(null);
    setError(null);
    if (!needsBytes) return;
    let alive = true;
    api.readOriginal(version.id).then(
      (bytes) => alive && setData(bytes),
      (err: unknown) => alive && setError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [version.id, needsBytes, attempt]);
  return { data, error, retry: () => setAttempt((a) => a + 1) };
}

export function DocumentViewer({
  doc,
  folderLabel,
  target,
  canRetry,
  retrying,
  onRetry,
  onMove,
  onDelete,
  onChanged,
  onBack,
  onBackToChat,
  onDismissTarget,
}: DocumentViewerProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const [versions, setVersions] = useState<DocumentVersion[] | null>(null);
  const [versionsError, setVersionsError] = useState<AppError | null>(null);
  const [viewedId, setViewedId] = useState<string | null>(() =>
    target?.versionId && target.versionId !== doc.current.id ? target.versionId : null,
  );
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<AppError | null>(null);
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<"ok" | "error" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A search result refers to the current version; a cited source to the version it came from.
  useEffect(() => {
    if (target) setViewedId(target.versionId && target.versionId !== doc.current.id ? target.versionId : null);
  }, [target]);

  // Versions are needed for the panel and when an older version is shown.
  const needVersions = infoOpen || viewedId !== null;
  useEffect(() => {
    if (!needVersions) return;
    let alive = true;
    setVersionsError(null);
    api.listVersions(doc.id).then(
      (items) => alive && setVersions(items),
      (err: unknown) => alive && setVersionsError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [doc.id, doc.updatedAt, doc.versionCount, needVersions]);

  const viewed = (viewedId && versions?.find((v) => v.id === viewedId)) || doc.current;
  // Keep the text status of the current version live (it changes while polling).
  const version = viewed.id === doc.current.id ? doc.current : viewed;
  const isCurrent = version.id === doc.current.id;
  // The requested version is not among the versions of the document any more.
  const versionMissing = viewedId !== null && versions !== null && !versions.some((v) => v.id === viewedId);
  const targetVersionId = target?.versionId ?? doc.current.id;
  const onTargetVersion = version.id === targetVersionId;
  const original = useOriginal(version);
  // Stable per search selection: re-renders (e.g. polling) must not jump back to the target.
  const pageTarget = useMemo(
    () => (target && target.unitKind === "page" ? { page: target.unit } : null),
    [target],
  );
  const blockTarget = useMemo(
    () => (target && target.unitKind === "block" ? { unit: target.unit } : null),
    [target],
  );
  const showLoading = useDelayedFlag(
    !original.data && !original.error && (version.kind === "pdf" || version.kind === "image"),
  );

  const uploadVersion = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setUploadError(null);
    setUploadNotice(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setUploadError(tooLargeError());
      return;
    }
    setUploading(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const updated = await api.importVersion(doc.id, bytes, file.name, file.lastModified || null);
      setViewedId(null);
      setUploadNotice(`Versione ${updated.current.versionNo} caricata.`);
      await onChanged();
    } catch (err) {
      setUploadError(toAppError(err));
    } finally {
      setUploading(false);
    }
  };

  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(version.sha256);
      setCopied("ok");
    } catch {
      setCopied("error");
    }
  };

  let body;
  if (viewedId !== null && versions === null && !versionsError) {
    // Waiting for the list of versions before showing an older one.
    body = null;
  } else if (version.kind === "pdf" || version.kind === "image") {
    if (original.error) {
      body = <ErrorBanner error={original.error} action={{ label: "Riprova", onClick: original.retry }} />;
    } else if (!original.data) {
      body = showLoading ? (
        <p className="loading viewer-loading" role="status">
          <Spinner />
          Caricamento…
        </p>
      ) : null;
    } else if (version.kind === "pdf") {
      body = (
        <Suspense fallback={null}>
          <PdfViewer
            key={version.id}
            data={original.data}
            title={doc.title}
            target={onTargetVersion ? pageTarget : null}
          />
        </Suspense>
      );
    } else {
      body = (
        <ImageViewer
          key={version.id}
          data={original.data}
          mediaType={version.mediaType}
          title={doc.title}
          width={version.imageWidth}
          height={version.imageHeight}
        />
      );
    }
  } else {
    body = (
      <TextViewer
        key={version.id}
        versionId={version.id}
        kind={version.kind}
        status={version.textStatus}
        target={onTargetVersion ? blockTarget : null}
      />
    );
  }

  const panelId = `info-panel-${doc.id}`;

  return (
    <article className="viewer" aria-labelledby={VIEWER_HEADING_ID}>
      <header className="viewer-head">
        {onBack ? (
          <button type="button" className="btn btn-ghost viewer-back" onClick={onBack}>
            <ArrowLeftIcon />
            Documenti
          </button>
        ) : null}
        <div className="viewer-heading">
          <h2 id={VIEWER_HEADING_ID} className="viewer-title" tabIndex={-1} title={doc.title}>
            {doc.title}
          </h2>
          <p className="viewer-sub">
            {KIND_LABEL[version.kind]} · {folderLabel}
            {version.textStatus !== "not_applicable" ? (
              <>
                {" · "}
                <StatusLabel
                  status={version.textStatus}
                  title={doc.title}
                  onRetry={isCurrent && canRetry ? onRetry : undefined}
                  retrying={retrying}
                />
              </>
            ) : null}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          aria-expanded={infoOpen}
          aria-controls={panelId}
          onClick={() => setInfoOpen((o) => !o)}
        >
          <InfoIcon />
          Informazioni
        </button>
      </header>

      {version.textStatus === "no_text" ? <p className="hint viewer-note">{STATUS_EXPLANATION.no_text}</p> : null}

      {!isCurrent ? (
        <div className="notice" role="status">
          <span>
            Stai vedendo la versione {version.versionNo} di {doc.versionCount}.
          </span>
          <button type="button" className="link-btn" onClick={() => setViewedId(null)}>
            Mostra la versione corrente
          </button>
        </div>
      ) : null}

      {versionMissing ? (
        <p className="notice" role="status">
          La versione citata non esiste più: viene mostrata la versione corrente.
        </p>
      ) : null}

      {target?.snippet && (onTargetVersion || versionMissing) ? (
        <aside className="cited-passage" aria-labelledby={`${panelId}-passage`}>
          <div className="cited-passage-head">
            <h3 id={`${panelId}-passage`} className="cited-passage-title">
              Passaggio citato · {target.unitKind === "page" ? `pagina ${target.unit}` : `blocco ${target.unit}`}
              {!isCurrent ? ` · versione ${version.versionNo}` : ""}
            </h3>
            {onBackToChat ? (
              <button type="button" className="link-btn" onClick={onBackToChat}>
                Torna alla chat
              </button>
            ) : null}
            {onDismissTarget ? (
              <button
                type="button"
                className="icon-btn icon-btn-sm"
                aria-label="Nascondi passaggio citato"
                title="Nascondi passaggio citato"
                onClick={onDismissTarget}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
          <p className="cited-passage-text" tabIndex={0}>
            {target.snippet}
          </p>
        </aside>
      ) : null}

      <div className="viewer-layout">
        <div className="viewer-body">{body}</div>

        {infoOpen ? (
          <aside id={panelId} className="info-panel" aria-label="Informazioni sul documento">
            <dl className="info-list">
              <div>
                <dt>Nome originale</dt>
                <dd className="break">{version.originalName}</dd>
              </div>
              <div>
                <dt>Formato</dt>
                <dd>
                  {KIND_LABEL[version.kind]} <span className="muted">({version.mediaType})</span>
                </dd>
              </div>
              <div>
                <dt>Dimensione</dt>
                <dd>{formatBytes(version.sizeBytes)}</dd>
              </div>
              {version.pageCount != null ? (
                <div>
                  <dt>Pagine</dt>
                  <dd>{version.pageCount}</dd>
                </div>
              ) : null}
              {version.imageWidth != null && version.imageHeight != null ? (
                <div>
                  <dt>Dimensioni</dt>
                  <dd>
                    {version.imageWidth} × {version.imageHeight} px
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>Importato</dt>
                <dd>
                  <time dateTime={version.importedAt}>{formatDateTime(version.importedAt)}</time>
                </dd>
              </div>
              {version.sourceModifiedAt ? (
                <div>
                  <dt>Ultima modifica del file</dt>
                  <dd>
                    <time dateTime={version.sourceModifiedAt}>{formatDateTime(version.sourceModifiedAt)}</time>
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>SHA-256</dt>
                <dd className="hash-row">
                  <code title={version.sha256}>{shortHash(version.sha256)}</code>
                  <button
                    type="button"
                    className="icon-btn icon-btn-sm"
                    aria-label="Copia SHA-256"
                    title="Copia SHA-256"
                    onClick={copyHash}
                  >
                    <CopyIcon />
                  </button>
                  <span role="status" className="hint">
                    {copied === "ok" ? "Copiato" : copied === "error" ? "Copia non riuscita" : ""}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Versione</dt>
                <dd>
                  {version.versionNo} di {doc.versionCount}
                </dd>
              </div>
            </dl>

            {doc.versionCount > 1 ? (
              <section className="info-section" aria-labelledby={`${panelId}-versions`}>
                <h3 id={`${panelId}-versions`} className="info-title">
                  Versioni
                </h3>
                {versionsError ? <ErrorBanner error={versionsError} /> : null}
                {versions ? (
                  <ul className="version-list">
                    {versions.map((v) => (
                      <li key={v.id}>
                        <button
                          type="button"
                          className="version-item"
                          aria-current={v.id === version.id ? "true" : undefined}
                          onClick={() => setViewedId(v.id === doc.current.id ? null : v.id)}
                        >
                          <span>
                            Versione {v.versionNo}
                            {v.id === doc.current.id ? " (corrente)" : ""}
                          </span>
                          <span className="version-meta">
                            <time dateTime={v.importedAt}>{formatDateTime(v.importedAt)}</time> ·{" "}
                            {formatBytes(v.sizeBytes)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}

            {uploadError ? <ErrorBanner error={uploadError} /> : null}
            {uploadNotice ? (
              <p className="hint" role="status">
                {uploadNotice}
              </p>
            ) : null}

            <div className="info-actions">
              <input
                ref={fileRef}
                type="file"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                accept={KIND_ACCEPT[doc.current.kind]}
                onChange={uploadVersion}
              />
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? <Spinner /> : null}
                Carica nuova versione
              </button>
              <button type="button" className="btn btn-secondary" onClick={onMove}>
                Sposta
              </button>
              <button type="button" className="btn btn-danger-quiet" onClick={onDelete}>
                Elimina
              </button>
            </div>
          </aside>
        ) : null}
      </div>
    </article>
  );
}
