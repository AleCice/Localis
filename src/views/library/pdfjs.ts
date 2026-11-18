// The only module that touches pdf.js. Loaded on demand (dynamic import) the first
// time a PDF is opened, and mocked in unit tests (pdf.js cannot run in jsdom).
import { AnnotationMode, getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Same-origin worker file emitted by Vite: allowed by `worker-src 'self'`.
GlobalWorkerOptions.workerSrc = workerSrc;

/** Upper bound for a page canvas (pixels): keeps memory bounded at high zoom or DPI. */
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export interface PageSize {
  width: number;
  height: number;
}

export interface RenderJob {
  promise: Promise<void>;
  cancel: () => void;
}

export interface PdfHandle {
  numPages: number;
  /** Size of a page at scale 1 (CSS pixels at 100%). */
  pageSize: (pageNumber: number) => Promise<PageSize>;
  /** Renders one page into the canvas at the given CSS scale (device pixel ratio handled here). */
  renderPage: (pageNumber: number, canvas: HTMLCanvasElement, scale: number) => RenderJob;
  destroy: () => void;
}

export function isCancel(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "RenderingCancelledException";
}

/**
 * Opens a PDF from bytes already in memory (read from Localis' archive). No network:
 * no range/stream loading, no worker fetches, no scripting, no XFA, no wasm decoders
 * (they would need extra CSP), annotations drawn as static appearance only.
 */
export async function openPdf(data: ArrayBuffer): Promise<PdfHandle> {
  const task = getDocument({
    // pdf.js transfers the buffer to its worker: hand it a copy so the caller's stays usable.
    data: new Uint8Array(data.slice(0)),
    useWorkerFetch: false,
    useWasm: false,
    enableXfa: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    disableWorkerRendering: true,
    isOffscreenCanvasSupported: true,
    stopAtErrors: false,
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (err) {
    void task.destroy();
    throw err;
  }

  return {
    numPages: doc.numPages,
    async pageSize(pageNumber) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    },
    renderPage(pageNumber, canvas, scale) {
      let renderTask: RenderTask | null = null;
      let cancelled = false;
      const promise = (async () => {
        const page = await doc.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale });
        let ratio = window.devicePixelRatio || 1;
        const pixels = base.width * base.height * ratio * ratio;
        if (pixels > MAX_CANVAS_PIXELS) ratio *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
        const viewport = page.getViewport({ scale: scale * ratio });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(base.width)}px`;
        canvas.style.height = `${Math.floor(base.height)}px`;
        renderTask = page.render({ canvas, viewport, annotationMode: AnnotationMode.ENABLE });
        try {
          await renderTask.promise;
        } finally {
          page.cleanup();
        }
      })();
      return {
        promise,
        cancel: () => {
          cancelled = true;
          renderTask?.cancel();
        },
      };
    },
    destroy() {
      void task.destroy();
    },
  };
}
