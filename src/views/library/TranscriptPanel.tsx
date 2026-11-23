import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TranscriptSegment } from "../../api/types";
import { readPref, STORAGE_KEYS, writePref } from "../../lib/storage";
import { formatTimestamp, spokenTimestamp } from "../../lib/time";

export const segmentId = (index: number) => `segment-${index}`;

function normalize(s: string) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Index in `segments` of the segment playing at `ms` (the last one starting at or before it). */
export function currentSegmentIndex(segments: TranscriptSegment[], ms: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // In a gap between two segments the previous one stays highlighted until the next starts.
  return found;
}

/** Text with the (accent/case-insensitive) matches of `query` marked. */
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const hay = normalize(text);
  const needle = normalize(query);
  // NFD normalisation keeps one output char per input char only for precomposed letters; fall
  // back to no marking when lengths differ.
  if (hay.length !== text.length || !needle) return <>{text}</>;
  const parts: { text: string; mark: boolean }[] = [];
  let at = 0;
  for (;;) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) parts.push({ text: text.slice(at, i), mark: false });
    parts.push({ text: text.slice(i, i + needle.length), mark: true });
    at = i + needle.length;
  }
  parts.push({ text: text.slice(at), mark: false });
  return (
    <>
      {parts.map((p, i) => (p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}
    </>
  );
}

interface TranscriptPanelProps {
  segments: TranscriptSegment[];
  /** «Trascrizione automatica (Whisper small) — può contenere errori» */
  label: string;
  durationMs: number | null;
  currentMs: number;
  onSeek: (ms: number) => void;
  /** Segment to scroll to and mark (search result or cited source); a new object scrolls again. */
  target: { index: number } | null;
  /** Selection for a new link (null = selection mode off). */
  selected: Set<number> | null;
  onToggleSelected: (index: number) => void;
}

export function TranscriptPanel({
  segments,
  label,
  durationMs,
  currentMs,
  onSeek,
  target,
  selected,
  onToggleSelected,
}: TranscriptPanelProps) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [follow, setFollowState] = useState(
    () => readPref(STORAGE_KEYS.transcriptFollow, ["true", "false"] as const, "true") === "true",
  );
  const listRef = useRef<HTMLOListElement>(null);
  const reference = durationMs ?? segments[segments.length - 1]?.endMs ?? 0;

  const setFollow = (value: boolean) => {
    setFollowState(value);
    writePref(STORAGE_KEYS.transcriptFollow, String(value));
  };

  const trimmed = query.trim();
  const visible = useMemo(() => {
    if (!trimmed) return segments;
    const needle = normalize(trimmed);
    return segments.filter((s) => normalize(s.text).includes(needle));
  }, [segments, trimmed]);

  const currentPos = currentSegmentIndex(segments, currentMs);
  const current = currentPos >= 0 ? segments[currentPos]! : null;

  // Follow playback: keep the current segment in view (not while filtering).
  useEffect(() => {
    if (!follow || trimmed || !current) return;
    const el = document.getElementById(`${id}-${segmentId(current.index)}`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [follow, trimmed, current, id]);

  // Jump to an external target once the list is rendered.
  useEffect(() => {
    if (!target) return;
    setQuery("");
    const el = document.getElementById(`${id}-${segmentId(target.index)}`);
    el?.scrollIntoView?.({ block: "center" });
  }, [target, id]);

  return (
    <section className="transcript-panel" aria-labelledby={`${id}-title`}>
      <div className="transcript-head">
        <h3 id={`${id}-title`} className="pane-title">
          Trascrizione
        </h3>
        <p className="transcript-label hint">{label}</p>
        <div className="transcript-tools">
          <input
            type="search"
            className="transcript-filter"
            aria-label="Cerca nella trascrizione"
            placeholder="Cerca nella trascrizione"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <label className="check-row">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            <span>Segui la riproduzione</span>
          </label>
        </div>
        {trimmed ? (
          <p className="hint" role="status">
            {visible.length === 0
              ? "Nessun segmento contiene il testo cercato."
              : visible.length === 1
                ? "1 segmento trovato."
                : `${visible.length} segmenti trovati.`}
          </p>
        ) : null}
      </div>
      <ol ref={listRef} className="transcript" aria-label="Segmenti della trascrizione">
        {visible.map((s) => {
          const isCurrent = current?.index === s.index;
          const isTarget = target?.index === s.index;
          const time = formatTimestamp(s.startMs, reference);
          return (
            <li
              key={s.index}
              id={`${id}-${segmentId(s.index)}`}
              className={`segment${isCurrent ? " is-current" : ""}${isTarget ? " is-target" : ""}`}
              aria-current={isCurrent ? "time" : undefined}
              data-index={s.index}
            >
              {selected ? (
                <input
                  type="checkbox"
                  className="segment-check"
                  checked={selected.has(s.index)}
                  onChange={() => onToggleSelected(s.index)}
                  aria-label={`Seleziona il segmento delle ${time}`}
                />
              ) : null}
              <button
                type="button"
                className="segment-time"
                onClick={() => onSeek(s.startMs)}
                aria-label={`Vai a ${time} (${spokenTimestamp(s.startMs)})`}
              >
                {time}
              </button>
              <span className="segment-text">
                <Highlighted text={s.text} query={trimmed} />
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
