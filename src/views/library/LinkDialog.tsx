import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import type { AppError, LibraryDocument, MediaLink, MediaLinkInput, Region } from "../../api/types";
import { toAppError } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { charCount } from "../../lib/format";
import { formatTimestamp, parseTimestamp } from "../../lib/time";
import { KIND_LABEL } from "./labels";
import { isValidRegion } from "./Region";
import { RegionPicker } from "./RegionPicker";

export const NOTE_MAX = 2000;

export interface LinkDraft {
  startMs: number | null;
  endMs: number | null;
}

interface LinkDialogProps {
  open: boolean;
  /** Link being edited, or null for a new one. */
  link: MediaLink | null;
  mediaVersionId: string;
  mediaTitle: string;
  durationMs: number | null;
  /** Current playback position («Imposta all'istante attuale»). */
  currentMs: () => number;
  /** Interval of the transcript segments selected in the panel, if any. */
  selection: LinkDraft | null;
  /** Initial interval for a new link (e.g. from the selected segments). */
  initial: LinkDraft | null;
  /** PDF and image documents of the project. */
  targets: LibraryDocument[];
  onClose: () => void;
  onSaved: (link: MediaLink) => void;
}

export function LinkDialog(props: LinkDialogProps) {
  const id = useId();
  return (
    <Dialog open={props.open} onClose={props.onClose} labelledBy={`${id}-title`} className="dialog-wide link-dialog">
      {props.open ? <LinkForm {...props} baseId={id} /> : null}
    </Dialog>
  );
}

type Errors = Partial<Record<"start" | "end" | "target" | "page" | "region" | "note", string>>;

const pctText = (n: number) => String(Math.round(n * 1000) / 10);

function LinkForm({
  link,
  mediaVersionId,
  mediaTitle,
  durationMs,
  currentMs,
  selection,
  initial,
  targets,
  onClose,
  onSaved,
  baseId,
}: LinkDialogProps & { baseId: string }) {
  const reference = durationMs ?? 0;
  const fmt = (ms: number | null) => (ms == null ? "" : formatTimestamp(ms, reference));
  const [start, setStart] = useState(() => fmt(link?.startMs ?? initial?.startMs ?? null));
  const [end, setEnd] = useState(() => fmt(link?.endMs ?? initial?.endMs ?? null));
  const [targetId, setTargetId] = useState<string>(() => link?.targetDocumentId ?? "");
  const [page, setPage] = useState(() => String(link?.targetPage ?? 1));
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [wholePage, setWholePage] = useState(() => !link?.region);
  const [region, setRegion] = useState<Region | null>(() => link?.region ?? null);
  const [fields, setFields] = useState(() => {
    const r = link?.region;
    return r ? { x: pctText(r.x), y: pctText(r.y), w: pctText(r.w), h: pctText(r.h) } : { x: "", y: "", w: "", h: "" };
  });
  const [note, setNote] = useState(() => link?.note ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const [error, setError] = useState<AppError | null>(null);
  const [saving, setSaving] = useState(false);
  const startRef = useRef<HTMLInputElement>(null);

  const target = targets.find((d) => d.id === targetId) ?? null;
  // Editing keeps the version the link was made on; a different document uses its current version.
  const targetVersionId =
    target && link && link.targetDocumentId === target.id ? link.targetVersionId : (target?.current.id ?? null);
  const isPdf = target?.current.kind === "pdf";
  const knownPages = pageCount ?? (isPdf ? target?.current.pageCount : null) ?? null;
  const pageNumber = Number.parseInt(page, 10);

  useEffect(() => {
    setPageCount(null);
  }, [targetVersionId]);

  const setRegionBoth = (next: Region) => {
    setRegion(next);
    setFields({ x: pctText(next.x), y: pctText(next.y), w: pctText(next.w), h: pctText(next.h) });
    setErrors((e) => ({ ...e, region: undefined }));
  };

  const fromFields = (next: typeof fields): Region | null => {
    const values = [next.x, next.y, next.w, next.h].map((v) => Number(v.replace(",", ".")));
    if ([next.x, next.y, next.w, next.h].some((v) => v.trim() === "") || values.some((v) => !Number.isFinite(v)))
      return null;
    const [x, y, w, h] = values.map((v) => v / 100) as [number, number, number, number];
    return { x, y, w, h };
  };

  const updateField = (key: keyof typeof fields, value: string) => {
    const next = { ...fields, [key]: value };
    setFields(next);
    setRegion(fromFields(next));
  };

  const groups = useMemo(() => {
    const pdfs = targets.filter((d) => d.current.kind === "pdf");
    const images = targets.filter((d) => d.current.kind === "image");
    return [
      { label: "PDF", items: pdfs },
      { label: "Immagini", items: images },
    ].filter((g) => g.items.length > 0);
  }, [targets]);

  const validate = (): { input: MediaLinkInput | null; errors: Errors } => {
    const next: Errors = {};
    const startMs = parseTimestamp(start);
    const endMs = parseTimestamp(end);
    if (startMs === null) next.start = "Indica l'inizio come mm:ss (ad esempio 12:30).";
    if (endMs === null) next.end = "Indica la fine come mm:ss (ad esempio 15:00).";
    if (startMs !== null && endMs !== null && endMs <= startMs) next.end = "La fine deve venire dopo l'inizio.";
    if (durationMs != null) {
      if (startMs !== null && startMs >= durationMs)
        next.start = `L'inizio supera la durata della registrazione (${formatTimestamp(durationMs)}).`;
      if (endMs !== null && endMs > durationMs)
        next.end = `La fine supera la durata della registrazione (${formatTimestamp(durationMs)}).`;
    }
    if (!target || !targetVersionId) next.target = "Scegli un PDF o un'immagine del progetto.";
    if (isPdf) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || (knownPages != null && pageNumber > knownPages))
        next.page = knownPages != null ? `Scegli una pagina da 1 a ${knownPages}.` : "Scegli una pagina valida.";
    }
    if (!wholePage && !isValidRegion(region))
      next.region =
        "La regione deve avere larghezza e altezza maggiori di 0 e stare dentro la pagina (x + larghezza e y + altezza al massimo 100 %).";
    if (charCount(note.trim()) > NOTE_MAX) next.note = `La nota supera ${NOTE_MAX} caratteri.`;
    if (Object.keys(next).length > 0 || startMs === null || endMs === null || !targetVersionId)
      return { input: null, errors: next };
    return {
      errors: next,
      input: {
        mediaVersionId,
        startMs,
        endMs,
        targetVersionId,
        targetPage: isPdf ? pageNumber : null,
        region: wholePage ? null : region,
        note: note.trim() ? note.trim() : null,
      },
    };
  };

  const submit = async () => {
    if (saving) return;
    const { input, errors: next } = validate();
    setErrors(next);
    setError(null);
    if (!input) {
      const first = (["start", "end", "target", "page", "region", "note"] as const).find((k) => next[k]);
      if (first) document.getElementById(`${baseId}-${first}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const saved = link ? await api.updateMediaLink(link.id, input) : await api.createMediaLink(input);
      onSaved(saved);
    } catch (err) {
      const appError = toAppError(err);
      const field: Record<string, keyof Errors> = {
        startMs: "start",
        endMs: "end",
        targetVersionId: "target",
        targetPage: "page",
        region: "region",
        note: "note",
      };
      const key = appError.field ? field[appError.field] : undefined;
      if (key) {
        setErrors({ [key]: appError.message });
        document.getElementById(`${baseId}-${key}`)?.focus();
      } else setError(appError);
      setSaving(false);
    }
  };

  const errorProps = (key: keyof Errors) =>
    errors[key]
      ? { "aria-invalid": true as const, "aria-describedby": `${baseId}-${key}-error` }
      : { "aria-invalid": undefined };
  const fieldError = (key: keyof Errors) =>
    errors[key] ? (
      <span id={`${baseId}-${key}-error`} className="field-error">
        {errors[key]}
      </span>
    ) : null;

  const timeField = (key: "start" | "end", label: string, value: string, set: (v: string) => void) => (
    <div className="field time-field">
      <label htmlFor={`${baseId}-${key}`}>{label}</label>
      <div className="inline-row">
        <input
          ref={key === "start" ? startRef : undefined}
          id={`${baseId}-${key}`}
          type="text"
          inputMode="numeric"
          placeholder="mm:ss"
          autoComplete="off"
          value={value}
          onChange={(e) => set(e.target.value)}
          {...errorProps(key)}
        />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => set(fmt(Math.round(currentMs())))}>
          Imposta all'istante attuale
        </button>
      </div>
      <div className="field-foot">{fieldError(key)}</div>
    </div>
  );

  return (
    <form
      className="dialog-body"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 id={`${baseId}-title`} className="dialog-title">
        {link ? "Modifica collegamento" : "Nuovo collegamento"}
      </h2>
      <p className="dialog-text">
        Collega un intervallo di «{mediaTitle}» a una pagina PDF o a un'immagine del progetto, eventualmente a una sua
        regione. L'originale non viene modificato.
      </p>

      <fieldset className="link-interval">
        <legend className="settings-subtitle">Intervallo della registrazione</legend>
        <div className="link-times">
          {timeField("start", "Inizio", start, setStart)}
          {timeField("end", "Fine", end, setEnd)}
        </div>
        {selection && selection.startMs != null && selection.endMs != null ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm link-from-selection"
            onClick={() => {
              setStart(fmt(selection.startMs));
              setEnd(fmt(selection.endMs));
            }}
          >
            Usa i segmenti selezionati ({fmt(selection.startMs)}–{fmt(selection.endMs)})
          </button>
        ) : null}
        <p className="hint">
          Formato mm:ss oppure h:mm:ss
          {durationMs != null ? ` · durata ${formatTimestamp(durationMs)}` : ""}.
        </p>
      </fieldset>

      <div className="field">
        <label htmlFor={`${baseId}-target`}>Destinazione</label>
        <select
          id={`${baseId}-target`}
          className="select"
          value={targetId}
          onChange={(e) => {
            setTargetId(e.target.value);
            setPage("1");
            setErrors((x) => ({ ...x, target: undefined, page: undefined }));
          }}
          {...errorProps("target")}
        >
          <option value="">Scegli un documento…</option>
          {groups.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="field-foot">{fieldError("target")}</div>
        {targets.length === 0 ? (
          <p className="hint">Il progetto non contiene PDF o immagini: importane uno per collegarlo.</p>
        ) : null}
      </div>

      {target && isPdf ? (
        <div className="field page-choice">
          <label htmlFor={`${baseId}-page`}>Pagina{knownPages != null ? ` (1–${knownPages})` : ""}</label>
          <input
            id={`${baseId}-page`}
            type="number"
            min={1}
            max={knownPages ?? undefined}
            step={1}
            value={page}
            onChange={(e) => setPage(e.target.value)}
            {...errorProps("page")}
          />
          <div className="field-foot">{fieldError("page")}</div>
        </div>
      ) : null}

      {target ? (
        <fieldset className="link-region">
          <legend className="settings-subtitle">Parte {isPdf ? "della pagina" : "dell'immagine"}</legend>
          <div className="segmented">
            <label className="segmented-option">
              <input type="radio" name={`${baseId}-whole`} checked={wholePage} onChange={() => setWholePage(true)} />
              <span>{isPdf ? "Pagina intera" : "Immagine intera"}</span>
            </label>
            <label className="segmented-option">
              <input type="radio" name={`${baseId}-whole`} checked={!wholePage} onChange={() => setWholePage(false)} />
              <span>Una regione</span>
            </label>
          </div>
          {!wholePage ? (
            <>
              <p className="hint" id={`${baseId}-region-hint`}>
                Trascina sull'anteprima per disegnare la regione, oppure inserisci posizione e dimensioni in percentuale.
              </p>
              <RegionPicker
                versionId={targetVersionId!}
                kind={isPdf ? "pdf" : "image"}
                mediaType={target.current.mediaType}
                title={target.title}
                page={isPdf && Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1}
                region={isValidRegion(region) ? region : null}
                onChange={setRegionBoth}
                onPageCount={setPageCount}
              />
              <div className="region-fields" id={`${baseId}-region`} tabIndex={-1}>
                {(
                  [
                    ["x", "Da sinistra (%)"],
                    ["y", "Dall'alto (%)"],
                    ["w", "Larghezza (%)"],
                    ["h", "Altezza (%)"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="field">
                    <label htmlFor={`${baseId}-region-${key}`}>{label}</label>
                    <input
                      id={`${baseId}-region-${key}`}
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      inputMode="decimal"
                      value={fields[key]}
                      onChange={(e) => updateField(key, e.target.value)}
                      {...errorProps("region")}
                    />
                  </div>
                ))}
              </div>
              <div className="field-foot">{fieldError("region")}</div>
            </>
          ) : null}
          {target ? (
            <p className="hint">
              {KIND_LABEL[target.current.kind]} · {target.title}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      <div className="field">
        <label htmlFor={`${baseId}-note`}>
          Nota <span className="optional">(facoltativa)</span>
        </label>
        <textarea id={`${baseId}-note`} value={note} onChange={(e) => setNote(e.target.value)} {...errorProps("note")} />
        <div className="field-foot">
          {fieldError("note")}
          <span className={charCount(note.trim()) > NOTE_MAX ? "counter over" : "counter"}>
            {charCount(note.trim())}/{NOTE_MAX}
          </span>
        </div>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
          Annulla
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving} aria-busy={saving}>
          {saving ? <Spinner /> : null}
          {link ? "Salva" : "Crea collegamento"}
        </button>
      </div>
    </form>
  );
}
