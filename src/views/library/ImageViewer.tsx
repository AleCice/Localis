import { useEffect, useState } from "react";
import { FitWidthIcon, MinusIcon, PlusIcon } from "../../components/Icons";
import type { Zoom } from "./PdfViewer";

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

interface ImageViewerProps {
  data: ArrayBuffer;
  mediaType: string;
  title: string;
  width: number | null;
  height: number | null;
}

export function ImageViewer({ data, mediaType, title, width, height }: ImageViewerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mediaType }));
    setUrl(objectUrl);
    setFailed(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data, mediaType]);

  const current = zoom === "fit" ? null : zoom;
  const zoomBy = (direction: 1 | -1) => {
    const base = current ?? 1;
    const next =
      direction > 0
        ? (ZOOM_STEPS.find((s) => s > base + 0.01) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1]!)
        : ([...ZOOM_STEPS].reverse().find((s) => s < base - 0.01) ?? ZOOM_STEPS[0]!);
    setZoom(next);
  };

  if (failed) return <p className="muted">L'immagine non può essere mostrata.</p>;

  return (
    <div className="image-viewer">
      <div className="viewer-toolbar">
        <div className="toolbar-group">
          <button type="button" className="icon-btn" aria-label="Riduci" title="Riduci" onClick={() => zoomBy(-1)}>
            <MinusIcon />
          </button>
          <span className="zoom-value" aria-live="polite">
            {current === null ? "Adattata" : `${Math.round(current * 100)}%`}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Ingrandisci"
            title="Ingrandisci"
            onClick={() => zoomBy(1)}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Adatta allo spazio"
            title="Adatta allo spazio"
            aria-pressed={zoom === "fit"}
            onClick={() => setZoom("fit")}
          >
            <FitWidthIcon />
          </button>
        </div>
      </div>
      <div className="image-scroller" tabIndex={0} role="region" aria-label={`Immagine: ${title}`}>
        {url ? (
          <img
            src={url}
            alt={title}
            className={zoom === "fit" ? "image-fit" : undefined}
            style={
              current !== null && width
                ? { width: `${width * current}px`, maxWidth: "none", height: "auto" }
                : undefined
            }
            width={width ?? undefined}
            height={height ?? undefined}
            onError={() => setFailed(true)}
          />
        ) : null}
      </div>
    </div>
  );
}
