import { useId } from "react";
import type { MediaLink } from "../../api/types";
import { formatInterval, formatTimestamp, spokenTimestamp } from "../../lib/time";
import { describeRegion } from "./Region";

export function linkTargetLabel(link: Pick<MediaLink, "targetTitle" | "targetPage" | "region">): string {
  return `${link.targetTitle}${link.targetPage != null ? ` · p. ${link.targetPage}` : ""}${link.region ? " · regione" : ""}`;
}

interface MediaLinksProps {
  links: MediaLink[];
  durationMs: number | null;
  currentMs: number;
  onSeek: (ms: number) => void;
  onOpen: (link: MediaLink) => void;
  onEdit: (link: MediaLink) => void;
  onDelete: (link: MediaLink) => void;
  onCreate: () => void;
  canCreate: boolean;
}

export const linkRowId = (id: string) => `media-link-${id}`;

/** Duration bar with the linked intervals (visual) and the equivalent list (accessible). */
export function MediaLinks({ links, durationMs, currentMs, onSeek, onOpen, onEdit, onDelete, onCreate, canCreate }: MediaLinksProps) {
  const id = useId();
  const reference = durationMs ?? 0;
  const pct = (ms: number) => (durationMs ? `${Math.min(100, Math.max(0, (ms / durationMs) * 100))}%` : "0%");
  return (
    <section className="media-links" aria-labelledby={`${id}-title`}>
      <div className="pane-head">
        <h3 id={`${id}-title`} className="pane-title">
          Collegamenti
        </h3>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCreate} disabled={!canCreate}>
          Nuovo collegamento
        </button>
      </div>

      {durationMs ? (
        // Visual summary only: every interval is also in the list below (keyboard and screen readers).
        <div className="timeline" aria-hidden="true">
          {links.map((link) => (
            <div
              key={link.id}
              className="timeline-interval"
              style={{ left: pct(link.startMs), width: `calc(${pct(link.endMs - link.startMs)} + 2px)` }}
              title={`${formatInterval(link.startMs, link.endMs)} → ${linkTargetLabel(link)}`}
              onClick={() => onOpen(link)}
            />
          ))}
          <div className="timeline-playhead" style={{ left: pct(currentMs) }} />
        </div>
      ) : null}

      {links.length === 0 ? (
        <p className="hint">
          Nessun collegamento. Collega un intervallo della registrazione a una pagina PDF o a un'immagine del progetto.
        </p>
      ) : (
        <ul className="link-list">
          {links.map((link) => {
            const interval = formatInterval(link.startMs, link.endMs);
            const playing = currentMs >= link.startMs && currentMs < link.endMs;
            return (
              <li key={link.id} id={linkRowId(link.id)} className={playing ? "link-row is-playing" : "link-row"}>
                <div className="link-main">
                  <button
                    type="button"
                    className="link-btn link-time"
                    onClick={() => onSeek(link.startMs)}
                    aria-label={`Riproduci da ${formatTimestamp(link.startMs, reference)} (${spokenTimestamp(link.startMs)})`}
                  >
                    {interval}
                  </button>
                  <span aria-hidden="true">→</span>
                  <button
                    type="button"
                    className="link-btn link-target"
                    onClick={() => onOpen(link)}
                    disabled={!link.available}
                    aria-label={`Apri ${linkTargetLabel(link)}${link.region ? `, ${describeRegion(link.region)}` : ""}`}
                  >
                    {linkTargetLabel(link)}
                  </button>
                  {!link.available ? <span className="hint">Destinazione non più disponibile</span> : null}
                </div>
                {link.note ? <p className="link-note">{link.note}</p> : null}
                <div className="link-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => onEdit(link)}
                    aria-label={`Modifica il collegamento ${interval} → ${linkTargetLabel(link)}`}
                  >
                    Modifica
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-danger-text"
                    onClick={() => onDelete(link)}
                    aria-label={`Elimina il collegamento ${interval} → ${linkTargetLabel(link)}`}
                  >
                    Elimina
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
