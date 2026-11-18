import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { ChevronIcon, FitWidthIcon, MinusIcon, PlusIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import type { PageSize, PdfHandle } from "./pdfjs";

const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const PAGE_GUTTER = 32;

export type Zoom = "fit" | number;

interface PdfViewerProps {
  data: ArrayBuffer;
  title: string;
  /** Page to show; a new object (e.g. from a search result) jumps there again. */
  target?: { page: number } | null;
}

function openError(err: unknown): AppError {
  const name = typeof err === "object" && err !== null ? (err as { name?: string }).name : undefined;
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (name === "PasswordException")
    return { code: "unsupported", message: "Il PDF è protetto da password e non può essere aperto.", detail };
  return { code: "internal", message: "Impossibile aprire il PDF.", detail };
}

/**
 * Single-page PDF viewer: one canvas at a time keeps memory bounded whatever the
 * page count. pdf.js is loaded on demand from ./pdfjs.
 */
export function PdfViewer({ data, title, target }: PdfViewerProps) {
  const [handle, setHandle] = useState<PdfHandle | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [page, setPage] = useState(target?.page ?? 1);
  const [pageInput, setPageInput] = useState(String(target?.page ?? 1));
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [size, setSize] = useState<PageSize | null>(null);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const showSpinner = useDelayedFlag(!handle && !error);
  const showRendering = useDelayedFlag(rendering, 300);

  // Open the document.
  useEffect(() => {
    let alive = true;
    let opened: PdfHandle | null = null;
    setHandle(null);
    setError(null);
    import("./pdfjs")
      .then(({ openPdf }) => openPdf(data))
      .then(
        (h) => {
          if (!alive) return h.destroy();
          opened = h;
          setHandle(h);
        },
        (err: unknown) => {
          if (alive) setError(openError(err));
        },
      );
    return () => {
      alive = false;
      opened?.destroy();
    };
  }, [data]);

  const numPages = handle?.numPages ?? 0;

  const goTo = useCallback(
    (next: number) => {
      if (!numPages) return;
      const clamped = Math.min(Math.max(1, Math.round(next)), numPages);
      setPage(clamped);
      setPageInput(String(clamped));
    },
    [numPages],
  );

  // Jump to an external target (search result).
  useEffect(() => {
    if (target) {
      setPage(target.page);
      setPageInput(String(target.page));
    }
  }, [target]);

  // Clamp once the page count is known.
  useEffect(() => {
    if (numPages && page > numPages) goTo(numPages);
  }, [numPages, page, goTo]);

  // Track the available width for «fit width».
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [handle]);

  // Page size at scale 1.
  useEffect(() => {
    if (!handle || page > handle.numPages) return;
    let alive = true;
    handle.pageSize(page).then(
      (s) => alive && setSize(s),
      (err: unknown) =>
        alive && setError({ code: "internal", message: "Impossibile mostrare la pagina.", detail: String(err) }),
    );
    return () => {
      alive = false;
    };
  }, [handle, page]);

  const fitScale = size && width > PAGE_GUTTER ? (width - PAGE_GUTTER) / size.width : 1;
  const scale = zoom === "fit" ? fitScale : zoom;

  // Render the current page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!handle || !size || !canvas || page > handle.numPages) return;
    setRendering(true);
    const job = handle.renderPage(page, canvas, scale);
    let alive = true;
    job.promise.then(
      () => alive && setRendering(false),
      (err: unknown) => {
        if (!alive) return;
        setRendering(false);
        const name = typeof err === "object" && err !== null ? (err as { name?: string }).name : "";
        if (name !== "RenderingCancelledException")
          setError({ code: "internal", message: "Impossibile mostrare la pagina.", detail: String(err) });
      },
    );
    return () => {
      alive = false;
      job.cancel();
    };
  }, [handle, size, page, scale]);

  const zoomBy = (direction: 1 | -1) => {
    const current = scale;
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((s) => s > current + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!)
        : ([...ZOOM_STEPS].reverse().find((s) => s < current - 0.01) ?? ZOOM_STEPS[0]!);
    setZoom(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
        goTo(page + 1);
        break;
      case "ArrowLeft":
      case "PageUp":
        goTo(page - 1);
        break;
      case "Home":
        goTo(1);
        break;
      case "End":
        goTo(numPages);
        break;
      case "+":
      case "=":
        zoomBy(1);
        break;
      case "-":
        zoomBy(-1);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const commitPageInput = () => {
    const value = Number.parseInt(pageInput, 10);
    if (Number.isFinite(value)) goTo(value);
    else setPageInput(String(page));
  };

  if (error) return <ErrorBanner error={error} />;

  if (!handle) {
    return showSpinner ? (
      <p className="loading viewer-loading" role="status">
        <Spinner />
        Apertura del PDF…
      </p>
    ) : null;
  }

  return (
    <div className="pdf-viewer">
      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <button
            type="button"
            className="icon-btn"
            aria-label="Pagina precedente"
            title="Pagina precedente"
            onClick={() => goTo(page - 1)}
            disabled={page <= 1}
          >
            <ChevronIcon direction="left" />
          </button>
          <label className="page-field">
            <span className="visually-hidden">Pagina</span>
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              size={Math.max(2, String(numPages).length)}
              onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commitPageInput}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitPageInput();
                }
              }}
            />
            <span>di {numPages}</span>
          </label>
          <button
            type="button"
            className="icon-btn"
            aria-label="Pagina successiva"
            title="Pagina successiva"
            onClick={() => goTo(page + 1)}
            disabled={page >= numPages}
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="icon-btn"
            aria-label="Riduci"
            title="Riduci"
            onClick={() => zoomBy(-1)}
            disabled={scale <= ZOOM_STEPS[0]! + 0.01}
          >
            <MinusIcon />
          </button>
          <span className="zoom-value" aria-live="polite">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Ingrandisci"
            title="Ingrandisci"
            onClick={() => zoomBy(1)}
            disabled={scale >= ZOOM_STEPS[ZOOM_STEPS.length - 1]! - 0.01}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Adatta alla larghezza"
            title="Adatta alla larghezza"
            aria-pressed={zoom === "fit"}
            onClick={() => setZoom("fit")}
          >
            <FitWidthIcon />
          </button>
          {showRendering ? <Spinner /> : null}
        </div>
      </div>
      <div
        ref={scrollerRef}
        className="pdf-scroller"
        tabIndex={0}
        role="region"
        aria-label={`Pagina ${page} di ${numPages}`}
        aria-keyshortcuts="ArrowLeft ArrowRight PageUp PageDown Home End + -"
        onKeyDown={onKeyDown}
      >
        <canvas
          ref={canvasRef}
          className="pdf-canvas"
          role="img"
          aria-label={`${title}, pagina ${page} di ${numPages}`}
        />
      </div>
    </div>
  );
}
