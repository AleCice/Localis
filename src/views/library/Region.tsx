import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Region } from "../../api/types";

/** «x 10 %, y 20 %, 30 × 15 %» for accessible descriptions. */
export function describeRegion(region: Region): string {
  const pct = (n: number) => `${Math.round(n * 1000) / 10} %`;
  return `regione da sinistra ${pct(region.x)}, dall'alto ${pct(region.y)}, larghezza ${pct(region.w)}, altezza ${pct(region.h)}`;
}

export function isValidRegion(region: Region | null): region is Region {
  if (!region) return false;
  const { x, y, w, h } = region;
  const eps = 1e-6;
  return (
    [x, y, w, h].every((n) => Number.isFinite(n)) &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1 + eps &&
    y + h <= 1 + eps
  );
}

const boxStyle = (r: Region) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.w * 100}%`,
  height: `${r.h * 100}%`,
});

/** Highlight drawn over a page or image (the original is never modified). */
export function RegionOverlay({ region, label }: { region: Region; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  // Bring the region into view inside the page scroller only (the viewer header stays in place).
  useEffect(() => {
    const el = ref.current;
    const scroller = el?.closest<HTMLElement>(".pdf-scroller, .image-scroller");
    if (!el || !scroller) return;
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    scroller.scrollTop += box.top - view.top - (view.height - box.height) / 2;
    scroller.scrollLeft += box.left - view.left - (view.width - box.width) / 2;
  }, [region]);
  return <div ref={ref} className="region-overlay" style={boxStyle(region)} role="img" aria-label={label} />;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
/** Regions smaller than this (fraction of the side) are treated as a click, not a drag. */
const MIN_SIDE = 0.01;

interface RegionDrawSurfaceProps {
  region: Region | null;
  onChange: (region: Region) => void;
}

/**
 * Transparent layer over a rendered page/image: drag with the mouse, pen or a finger to draw a
 * rectangle. The keyboard alternative is the numeric fields of the link dialog.
 */
export function RegionDrawSurface({ region, onChange }: RegionDrawSurfaceProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Region | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const point = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: clamp01(rect.width ? (event.clientX - rect.left) / rect.width : 0),
      y: clamp01(rect.height ? (event.clientY - rect.top) / rect.height : 0),
    };
  };

  const toRegion = (a: { x: number; y: number }, b: { x: number; y: number }): Region => ({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  });

  const shown = draft ?? region;

  return (
    <div
      ref={ref}
      className="region-draw"
      data-testid="region-draw"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        start.current = point(event);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setDraft({ ...start.current, w: 0, h: 0 });
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        setDraft(toRegion(start.current, point(event)));
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        const next = toRegion(start.current, point(event));
        start.current = null;
        setDraft(null);
        if (next.w >= MIN_SIDE && next.h >= MIN_SIDE) onChange(next);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDraft(null);
      }}
    >
      {shown && shown.w > 0 && shown.h > 0 ? <div className="region-box" style={boxStyle(shown)} /> : null}
    </div>
  );
}
