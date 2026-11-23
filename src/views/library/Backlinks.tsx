import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { MediaLink } from "../../api/types";
import { formatInterval } from "../../lib/time";

interface BacklinksProps {
  versionId: string;
  /** Opens the recording at the start of the interval. */
  onOpen: (link: MediaLink) => void;
}

/** «Collegato a lezione.mp4 · 12:30–15:00» for a PDF or image that recordings link to. */
export function Backlinks({ versionId, onOpen }: BacklinksProps) {
  const [links, setLinks] = useState<MediaLink[]>([]);
  useEffect(() => {
    let alive = true;
    setLinks([]);
    api.listLinksForTarget(versionId).then(
      (items) => alive && setLinks(items),
      () => {
        /* backlinks are an aid: a failure leaves the viewer as it is */
      },
    );
    return () => {
      alive = false;
    };
  }, [versionId]);

  if (links.length === 0) return null;
  return (
    <aside className="backlinks" aria-label="Collegamenti dalle registrazioni">
      <ul className="backlink-list">
        {links.map((link) => (
          <li key={link.id}>
            <button type="button" className="backlink" onClick={() => onOpen(link)} disabled={!link.available}>
              Collegato a {link.mediaTitle} · {formatInterval(link.startMs, link.endMs)}
              {link.targetPage != null ? <span className="hint"> · p. {link.targetPage}</span> : null}
              {link.region ? <span className="hint"> · regione</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
