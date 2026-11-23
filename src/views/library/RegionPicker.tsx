import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { AppError, Region } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import type { PdfHandle } from "./pdfjs";
import { RegionDrawSurface } from "./Region";

/** Size the page is rendered at in the picker (CSS pixels), at most: the whole page stays visible. */
const MAX_WIDTH = 560;
const MAX_HEIGHT = 420;

interface RegionPickerProps {
  versionId: string;
  kind: "pdf" | "image";
  mediaType: string;
  title: string;
  /** PDF page (1-based); ignored for images. */
  page: number;
  region: Region | null;
  onChange: (region: Region) => void;
  /** PDF only: number of pages, once the document is open. */
  onPageCount?: (count: number) => void;
}

/** Renders the target page (pdf.js, same renderer as the viewer) or image to draw a region on it. */
export function RegionPicker({ versionId, kind, mediaType, title, page, region, onChange, onPageCount }: RegionPickerProps) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [handle, setHandle] = useState<PdfHandle | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageCountRef = useRef(onPageCount);
  pageCountRef.current = onPageCount;

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.readOriginal(versionId).then(
      (bytes) => alive && setData(bytes),
      (err: unknown) => alive && setError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [versionId]);

  // Image: object URL of the original bytes.
  useEffect(() => {
    if (kind !== "image" || !data) return;
    const url = URL.createObjectURL(new Blob([data], { type: mediaType }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [kind, data, mediaType]);

  // PDF: open once per document.
  useEffect(() => {
    if (kind !== "pdf" || !data) return;
    let alive = true;
    let opened: PdfHandle | null = null;
    import("./pdfjs")
      .then(({ openPdf }) => openPdf(data))
      .then(
        (h) => {
          if (!alive) return h.destroy();
          opened = h;
          setHandle(h);
          pageCountRef.current?.(h.numPages);
        },
        (err: unknown) =>
          alive && setError({ code: "internal", message: "Impossibile aprire il PDF.", detail: String(err) }),
      );
    return () => {
      alive = false;
      opened?.destroy();
    };
  }, [kind, data]);

  // PDF: render the chosen page to fit the picker.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!handle || !canvas || page < 1 || page > handle.numPages) return;
    let alive = true;
    let job: { cancel: () => void } | null = null;
    setRendered(false);
    handle
      .pageSize(page)
      .then((size) => {
        if (!alive) return;
        const available = Math.min(MAX_WIDTH, boxRef.current?.clientWidth || MAX_WIDTH);
        const scale = Math.min(available / size.width, MAX_HEIGHT / size.height);
        const render = handle.renderPage(page, canvas, Math.max(0.1, scale));
        job = render;
        return render.promise;
      })
      .then(
        () => alive && setRendered(true),
        (err: unknown) => {
          const name = typeof err === "object" && err !== null ? (err as { name?: string }).name : "";
          if (alive && name !== "RenderingCancelledException")
            setError({ code: "internal", message: "Impossibile mostrare la pagina.", detail: String(err) });
        },
      );
    return () => {
      alive = false;
      job?.cancel();
    };
  }, [handle, page]);

  if (error) return <ErrorBanner error={error} />;
  const loading = !data || (kind === "pdf" ? !handle : !imageUrl);

  return (
    <div ref={boxRef} className="region-picker">
      {loading ? (
        <p className="loading" role="status">
          <Spinner />
          Caricamento della pagina…
        </p>
      ) : null}
      <div className="region-frame" hidden={loading}>
        {kind === "pdf" ? (
          <canvas
            ref={canvasRef}
            className="pdf-canvas"
            role="img"
            aria-label={`${title}, pagina ${page}${rendered ? "" : " (in caricamento)"}`}
          />
        ) : imageUrl ? (
          <img src={imageUrl} alt={title} className="region-image" />
        ) : null}
        {!loading ? <RegionDrawSurface region={region} onChange={onChange} /> : null}
      </div>
    </div>
  );
}
