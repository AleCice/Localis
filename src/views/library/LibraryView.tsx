import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { api } from "../../api/client";
import type { AppError, Folder, LibraryDocument, Project, SearchHit } from "../../api/types";
import { IMPORT_EXTENSIONS, IMPORT_MAX_BYTES, toAppError } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { FolderPlusIcon, PanelIcon, SearchIcon, UploadIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import type { LibraryLink } from "../../lib/navigation";
import { useLibrary } from "../../hooks/useLibrary";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { LoadStatus } from "../../hooks/useProjects";
import { DocumentList, documentRowId } from "./DocumentList";
import { DocumentViewer, tooLargeError, VIEWER_HEADING_ID, type ViewerTarget } from "./DocumentViewer";
import { FolderNameDialog } from "./FolderNameDialog";
import { folderNodeId, FolderTree } from "./FolderTree";
import { ImportSummary, type ImportOutcome, type ImportState } from "./ImportSummary";
import { MoveDialog } from "./MoveDialog";
import { SearchResults } from "./SearchResults";

/** Below this width the browser (folders + list) and the viewer are shown one at a time. */
export const LIBRARY_STACKED_QUERY = "(max-width: 60rem)";
export const SEARCH_DEBOUNCE_MS = 250;
const ACCEPT = IMPORT_EXTENSIONS.map((ext) => `.${ext}`).join(",");

interface LibraryViewProps {
  project: Project | null;
  projectsStatus: LoadStatus;
  onGoToProjects: () => void;
  sidebarToggle: ReactNode;
  /** Open this document at this point (e.g. a cited source from the chat). */
  link?: LibraryLink | null;
  /** Called once `link` has been applied. */
  onLinkHandled?: () => void;
  /** Present when the chat is open in the background. */
  onBackToChat?: () => void;
}

export function LibraryView({
  project,
  projectsStatus,
  onGoToProjects,
  sidebarToggle,
  link = null,
  onLinkHandled,
  onBackToChat,
}: LibraryViewProps) {
  if (project)
    return (
      <Library
        key={project.id}
        project={project}
        sidebarToggle={sidebarToggle}
        link={link}
        onLinkHandled={onLinkHandled}
        onBackToChat={onBackToChat}
      />
    );
  return (
    <div className="view">
      <div className="view-header">
        {sidebarToggle}
        <h1 className="view-title">Libreria</h1>
      </div>
      <div className="view-content">
        {projectsStatus === "ready" ? (
          <div className="empty">
            <p>La libreria appartiene a un progetto. Crea o seleziona un progetto per iniziare.</p>
            <button type="button" className="btn btn-primary" onClick={onGoToProjects}>
              Vai a Progetti
            </button>
          </div>
        ) : projectsStatus === "error" ? (
          <div className="empty">
            <p>Non è stato possibile caricare i progetti.</p>
            <button type="button" className="btn btn-secondary" onClick={onGoToProjects}>
              Vai a Progetti
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

type FolderDialogMode = { kind: "create"; parentName: string | null } | { kind: "rename"; folder: Folder } | null;

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

interface LibraryProps {
  project: Project;
  sidebarToggle: ReactNode;
  link: LibraryLink | null;
  onLinkHandled?: () => void;
  onBackToChat?: () => void;
}

function Library({ project, sidebarToggle, link, onLinkHandled, onBackToChat }: LibraryProps) {
  const store = useLibrary(project.id);
  const { folders, documents, jobs } = store;
  const stacked = useMediaQuery(LIBRARY_STACKED_QUERY);

  const [folderId, setFolderId] = useState<string | null>(null);
  const [pendingFolderFocus, setPendingFolderFocus] = useState<string | null>(null);
  // Runs after every render until the newly created folder's node exists, then focuses it.
  // (Runs after the dialog's layout effect, so it wins over the dialog's return-focus.)
  // The tree may re-render the node (e.g. while ancestors expand), so keep re-applying focus
  // for a short settle window instead of focusing once.
  useEffect(() => {
    if (!pendingFolderFocus) return;
    const node = document.getElementById(folderNodeId(pendingFolderFocus));
    if (node && document.activeElement !== node) node.focus();
  });
  useEffect(() => {
    if (!pendingFolderFocus) return;
    const id = pendingFolderFocus;
    let frames = 0;
    let raf = 0;
    const tick = () => {
      const node = document.getElementById(folderNodeId(id));
      if (node && document.activeElement !== node) node.focus();
      if (++frames < 10) raf = requestAnimationFrame(tick);
      else setPendingFolderFocus(null);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pendingFolderFocus]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const [pane, setPane] = useState<"browser" | "viewer">("browser");
  const [browserHidden, setBrowserHidden] = useState(false);
  const [notice, setNotice] = useState<AppError | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(() => new Set());

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<AppError | null>(null);
  const searchId = useRef(0);

  const [importState, setImportState] = useState<ImportState | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const [folderDialog, setFolderDialog] = useState<FolderDialogMode>(null);
  const [deletingFolder, setDeletingFolder] = useState<Folder | null>(null);
  const [moving, setMoving] = useState<LibraryDocument | null>(null);
  const [deletingDoc, setDeletingDoc] = useState<LibraryDocument | null>(null);

  const showLoading = useDelayedFlag(store.status === "loading");

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const currentFolder = folderId ? (folderById.get(folderId) ?? null) : null;
  const folderLabel = useCallback(
    (id: string | null) => (id ? (folderById.get(id)?.name ?? project.name) : project.name),
    [folderById, project.name],
  );

  // The open folder was deleted elsewhere: fall back to the root.
  useEffect(() => {
    if (store.status === "ready" && folderId && !folderById.has(folderId)) setFolderId(null);
  }, [store.status, folderId, folderById]);

  const selected = documents.find((d) => d.id === selectedId) ?? null;
  useEffect(() => {
    if (store.status === "ready" && selectedId && !selected) setSelectedId(null);
  }, [store.status, selectedId, selected]);

  const showViewer = stacked ? pane === "viewer" && selected !== null : true;
  const showBrowser = stacked ? !showViewer : !(browserHidden && selected);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of documents) map.set(d.folderId ?? "", (map.get(d.folderId ?? "") ?? 0) + 1);
    return map;
  }, [documents]);
  const inFolder = documents.filter((d) => (d.folderId ?? null) === folderId);
  const excludedFromSearch = documents.filter((d) => d.current.textStatus !== "extracted").length;

  const failedJob = useCallback(
    (doc: LibraryDocument) => jobs.find((j) => j.versionId === doc.current.id && j.state === "failed") ?? null,
    [jobs],
  );

  // ---- Search (debounced; Enter searches immediately)
  useEffect(() => {
    const timer = window.setTimeout(() => setSubmitted(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Changes when the searchable set changes (an extraction finishes, a version or document is
  // added or removed), so open results refresh without the user searching again.
  const searchableKey = useMemo(
    () =>
      store.documents
        .filter((d) => d.current.textStatus === "extracted")
        .map((d) => d.current.id)
        .sort()
        .join(","),
    [store.documents],
  );

  useEffect(() => {
    const id = ++searchId.current;
    setSearchError(null);
    if (!submitted) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    api.search(project.id, submitted).then(
      (result) => {
        if (id !== searchId.current) return;
        setHits(result);
        setSearching(false);
      },
      (err: unknown) => {
        if (id !== searchId.current) return;
        setHits(null);
        setSearchError(toAppError(err));
        setSearching(false);
      },
    );
  }, [submitted, project.id, searchableKey]);

  // ---- Navigation
  const openDocument = (doc: LibraryDocument, nextTarget: ViewerTarget | null = null) => {
    setSelectedId(doc.id);
    setTarget(nextTarget);
    setPane("viewer");
    if (!submitted) setFolderId(doc.folderId ?? null);
    if (stacked) requestAnimationFrame(() => document.getElementById(VIEWER_HEADING_ID)?.focus());
  };

  const openHit = (hit: SearchHit) => {
    const doc = documents.find((d) => d.id === hit.documentId);
    if (!doc) {
      setNotice({ code: "not_found", message: "Il documento non esiste più." });
      void store.refresh();
      return;
    }
    openDocument(doc, { unit: hit.unit, unitKind: hit.unitKind });
  };

  // ---- External link (a source cited in the chat): open that document and version at that point.
  const handledLink = useRef<number | null>(null);
  useEffect(() => {
    if (!link || store.status !== "ready" || handledLink.current === link.nonce) return;
    handledLink.current = link.nonce;
    const doc = documents.find((d) => d.id === link.documentId);
    if (doc) {
      setQuery("");
      setSubmitted("");
      setNotice(null);
      setSelectedId(doc.id);
      setTarget({ unit: link.unit, unitKind: link.unitKind, versionId: link.versionId, snippet: link.snippet });
      setPane("viewer");
      setFolderId(doc.folderId ?? null);
      requestAnimationFrame(() => document.getElementById(VIEWER_HEADING_ID)?.focus());
    } else {
      setNotice({ code: "not_found", message: "Il documento citato non esiste più." });
    }
    onLinkHandled?.();
  }, [link, store.status, documents, onLinkHandled]);

  const backToBrowser = () => {
    setPane("browser");
    const id = selectedId;
    requestAnimationFrame(() => (id ? document.getElementById(documentRowId(id)) : null)?.focus());
  };

  // ---- Import
  const importFiles = async (files: File[]) => {
    if (files.length === 0 || importState?.running) return;
    const destination = folderId;
    const outcomes: ImportOutcome[] = [];
    setImportState({ running: true, total: files.length, outcomes: [], folderLabel: folderLabel(destination) });
    for (const file of files) {
      let outcome: ImportOutcome;
      if (file.size > IMPORT_MAX_BYTES) {
        outcome = { name: file.name, kind: "error", error: tooLargeError() };
      } else {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await api.importDocument(bytes, {
            projectId: project.id,
            folderId: destination,
            fileName: file.name,
            lastModified: file.lastModified || null,
          });
          outcome = { name: file.name, kind: result.status, document: result.document };
        } catch (err) {
          outcome = { name: file.name, kind: "error", error: toAppError(err) };
        }
      }
      outcomes.push(outcome);
      setImportState((prev) => (prev ? { ...prev, outcomes: [...outcomes] } : prev));
    }
    setImportState((prev) => (prev ? { ...prev, running: false } : prev));
    await store.refresh();
    const only = outcomes.length === 1 ? outcomes[0] : undefined;
    if (only && only.kind !== "error") openDocument(only.document);
  };

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = importState?.running ? "none" : "copy";
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void importFiles(Array.from(event.dataTransfer.files));
  };

  // ---- Retry extraction
  const retry = async (doc: LibraryDocument) => {
    const job = failedJob(doc);
    if (!job) return;
    setRetrying((prev) => new Set(prev).add(doc.id));
    try {
      await api.retryJob(job.id);
      setNotice(null);
    } catch (err) {
      setNotice(toAppError(err));
    } finally {
      await store.refresh();
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(doc.id);
        return next;
      });
    }
  };

  // ---- Folders
  const submitFolder = async (name: string): Promise<Folder> => {
    const folder =
      folderDialog?.kind === "rename"
        ? await api.renameFolder(folderDialog.folder.id, name)
        : await api.createFolder({ projectId: project.id, parentId: folderId, name });
    // Refresh before closing so focus can land on the folder in the tree.
    await store.refresh();
    return folder;
  };

  const deleteFolder = async () => {
    if (!deletingFolder) return;
    try {
      await api.deleteFolder(deletingFolder.id);
    } catch (err) {
      const error = toAppError(err);
      if (error.code !== "not_found") throw error;
    }
    await store.refresh();
    setFolderId(deletingFolder.parentId);
    setDeletingFolder(null);
  };

  // ---- Documents
  const moveDocument = async (doc: LibraryDocument, destination: string | null) => {
    await api.moveDocument(doc.id, destination);
    await store.refresh();
    setMoving(null);
    if (!submitted) setFolderId(destination);
  };

  const deleteDocument = async () => {
    if (!deletingDoc) return;
    try {
      await api.deleteDocument(deletingDoc.id);
    } catch (err) {
      const error = toAppError(err);
      if (error.code !== "not_found") throw error;
    }
    await store.refresh();
    setSelectedId(null);
    setPane("browser");
    setDeletingDoc(null);
  };

  const libraryEmpty = store.status === "ready" && documents.length === 0 && folders.length === 0;

  return (
    <div className={stacked ? "view view-library is-stacked" : "view view-library"}>
      <div className="view-header library-header">
        {sidebarToggle}
        <div className="view-title library-title">
          <h1>Libreria</h1>
          <p className="view-context" title={project.name}>
            {project.name}
          </p>
        </div>
        <form
          role="search"
          className="search-field"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(query.trim());
          }}
        >
          <SearchIcon />
          <input
            type="search"
            aria-label="Cerca nei documenti"
            placeholder="Cerca nei documenti"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </form>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="import-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void importFiles(files);
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => fileRef.current?.click()}
          disabled={store.status !== "ready" || importState?.running}
        >
          <UploadIcon />
          Importa
        </button>
      </div>

      {store.status === "loading" && showLoading ? (
        <p className="loading" role="status">
          <Spinner />
          Caricamento…
        </p>
      ) : null}
      {store.status === "error" && store.loadError ? (
        <ErrorBanner error={store.loadError} action={{ label: "Riprova", onClick: store.reload }} />
      ) : null}

      {store.status === "ready" ? (
        <div
          className="library"
          data-layout={stacked ? "stacked" : "split"}
          data-dragging={dragging || undefined}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {notice || importState ? (
            <div className="library-messages">
              {notice ? (
                <ErrorBanner error={notice} action={{ label: "Chiudi", onClick: () => setNotice(null) }} />
              ) : null}
              {importState ? (
                <ImportSummary
                  state={importState}
                  onOpen={(doc) => openDocument(doc)}
                  onDismiss={() => setImportState(null)}
                />
              ) : null}
            </div>
          ) : null}

          <div className="library-panes">
            {showBrowser ? (
              <div className="library-browser">
                <section className="browser-section" aria-labelledby="folders-title">
                  <div className="pane-head">
                    <h2 id="folders-title" className="pane-title">
                      Cartelle
                    </h2>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setFolderDialog({ kind: "create", parentName: currentFolder?.name ?? null })}
                    >
                      <FolderPlusIcon />
                      Nuova cartella
                    </button>
                  </div>
                  <FolderTree
                    rootLabel={project.name}
                    folders={folders}
                    currentId={folderId}
                    counts={counts}
                    onSelect={(id) => {
                      setFolderId(id);
                      setQuery("");
                      setSubmitted("");
                    }}
                  />
                </section>

                {submitted ? (
                  <div className="browser-section browser-docs">
                    <SearchResults
                      query={submitted}
                      hits={hits}
                      loading={searching}
                      error={searchError}
                      excludedCount={excludedFromSearch}
                      onOpen={openHit}
                    />
                  </div>
                ) : (
                  <section className="browser-section browser-docs" aria-labelledby="folder-title">
                    <div className="pane-head">
                      <h2 id="folder-title" className="pane-title" title={folderLabel(folderId)}>
                        {folderLabel(folderId)}
                      </h2>
                      {currentFolder ? (
                        <div className="pane-actions">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setFolderDialog({ kind: "rename", folder: currentFolder })}
                            aria-label={`Rinomina la cartella «${currentFolder.name}»`}
                          >
                            Rinomina
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm btn-danger-text"
                            onClick={() => setDeletingFolder(currentFolder)}
                            aria-label={`Elimina la cartella «${currentFolder.name}»`}
                          >
                            Elimina
                          </button>
                        </div>
                      ) : null}
                    </div>
                    {libraryEmpty ? (
                      <div className="library-empty">
                        <p>
                          Nessun documento. Importa PDF, testi, Markdown, documenti Word o immagini con «Importa» o
                          trascinandoli qui.
                        </p>
                        <p className="hint">
                          Localis conserva una copia di ogni file: gli originali sul disco non vengono modificati.
                        </p>
                      </div>
                    ) : inFolder.length === 0 ? (
                      <p className="muted library-empty">Nessun documento in questa cartella.</p>
                    ) : (
                      <DocumentList
                        documents={inFolder}
                        selectedId={selectedId}
                        onOpen={(doc) => openDocument(doc)}
                        onRetry={(doc) => void retry(doc)}
                        canRetry={(doc) => failedJob(doc) !== null}
                        retrying={retrying}
                      />
                    )}
                  </section>
                )}
              </div>
            ) : null}

            {showViewer ? (
              <div className="library-viewer">
                {selected ? (
                  <>
                    {!stacked ? (
                      <button
                        type="button"
                        className="icon-btn browser-toggle"
                        aria-label={browserHidden ? "Mostra cartelle e documenti" : "Nascondi cartelle e documenti"}
                        title={browserHidden ? "Mostra cartelle e documenti" : "Nascondi cartelle e documenti"}
                        aria-pressed={!browserHidden}
                        onClick={() => setBrowserHidden((h) => !h)}
                      >
                        <PanelIcon />
                      </button>
                    ) : null}
                    <DocumentViewer
                      key={selected.id}
                      doc={selected}
                      folderLabel={folderLabel(selected.folderId)}
                      target={target}
                      canRetry={failedJob(selected) !== null}
                      retrying={retrying.has(selected.id)}
                      onRetry={() => void retry(selected)}
                      onMove={() => setMoving(selected)}
                      onDelete={() => setDeletingDoc(selected)}
                      onChanged={store.refresh}
                      onBack={stacked ? backToBrowser : undefined}
                      onBackToChat={onBackToChat}
                      onDismissTarget={() => setTarget(null)}
                    />
                  </>
                ) : (
                  <p className="viewer-empty muted">Seleziona un documento per visualizzarlo.</p>
                )}
              </div>
            ) : null}
          </div>

          {dragging ? (
            <div className="drop-overlay" aria-hidden="true">
              <p>
                <UploadIcon />
                Rilascia i file per importarli in «{folderLabel(folderId)}»
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <FolderNameDialog
        mode={folderDialog}
        onClose={() => setFolderDialog(null)}
        onSubmit={submitFolder}
        onDone={(folder) => {
          setFolderDialog(null);
          setFolderId(folder.id);
          // The node may appear only after its ancestors expand: focus it once rendered.
          setPendingFolderFocus(folder.id);
        }}
        focusAfterDone={() => null}
      />
      <ConfirmDialog
        open={deletingFolder !== null}
        title={`Eliminare la cartella «${deletingFolder?.name ?? ""}»?`}
        confirmLabel="Elimina"
        onCancel={() => setDeletingFolder(null)}
        onConfirm={deleteFolder}
        focusAfterConfirm={() => document.getElementById(folderNodeId(folderId))}
      >
        <p>Si possono eliminare solo le cartelle vuote.</p>
      </ConfirmDialog>
      <MoveDialog
        doc={moving}
        folders={folders}
        rootLabel={project.name}
        onClose={() => setMoving(null)}
        onMove={moveDocument}
      />
      <ConfirmDialog
        open={deletingDoc !== null}
        title={`Eliminare «${deletingDoc?.title ?? ""}»?`}
        confirmLabel="Elimina"
        onCancel={() => setDeletingDoc(null)}
        onConfirm={deleteDocument}
        focusAfterConfirm={() =>
          document.querySelector<HTMLElement>(".doc-open") ?? document.getElementById(folderNodeId(folderId))
        }
      >
        <p>
          Il documento verrà rimosso dalla libreria insieme alle copie di tutte le sue versioni conservate da Localis. I
          file sul tuo disco non vengono toccati.
        </p>
      </ConfirmDialog>
    </div>
  );
}
