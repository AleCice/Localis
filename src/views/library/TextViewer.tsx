import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AppError, DocumentKind, TextStatus, TextUnit } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { STATUS_EXPLANATION } from "./labels";

export const textUnitId = (unit: number) => `text-unit-${unit}`;

interface TextViewerProps {
  versionId: string;
  kind: DocumentKind;
  status: TextStatus;
  /** Block to scroll to and highlight; a new object jumps again. */
  target?: { unit: number } | null;
}

/** Extracted text of TXT, Markdown (raw) and DOCX, block by block. Not the original layout. */
export function TextViewer({ versionId, kind, status, target }: TextViewerProps) {
  const [units, setUnits] = useState<TextUnit[] | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const showSpinner = useDelayedFlag(status === "extracted" && units === null && !error);

  useEffect(() => {
    setUnits(null);
    setError(null);
    if (status !== "extracted") return;
    let alive = true;
    api.getText(versionId).then(
      (items) => alive && setUnits(items),
      (err: unknown) => alive && setError(toAppError(err)),
    );
    return () => {
      alive = false;
    };
  }, [versionId, status, attempt]);

  useEffect(() => {
    if (!target || !units) return;
    const el = document.getElementById(textUnitId(target.unit));
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.focus({ preventScroll: true });
  }, [target, units]);

  const note =
    kind === "markdown"
      ? "Testo estratto dal file Markdown, mostrato senza formattazione."
      : kind === "docx"
        ? "Testo estratto dal documento Word: l'impaginazione originale non viene mostrata."
        : "Testo estratto dal file.";

  let body;
  if (status === "pending") {
    body = (
      <p className="loading" role="status">
        <Spinner />
        Estrazione del testo in corso…
      </p>
    );
  } else if (status === "no_text") {
    body = <p className="muted">Il file non contiene testo.</p>;
  } else if (status === "failed") {
    body = <p className="muted">Non è stato possibile estrarre il testo.</p>;
  } else if (status === "not_applicable") {
    body = <p className="muted">{STATUS_EXPLANATION.not_applicable}</p>;
  } else if (error) {
    body = <ErrorBanner error={error} action={{ label: "Riprova", onClick: () => setAttempt((a) => a + 1) }} />;
  } else if (!units) {
    body = showSpinner ? (
      <p className="loading" role="status">
        <Spinner />
        Caricamento…
      </p>
    ) : null;
  } else if (units.length === 0) {
    body = <p className="muted">Il file non contiene testo.</p>;
  } else {
    body = (
      <div className="text-blocks">
        {units.map((u) => (
          <p
            key={u.unit}
            id={textUnitId(u.unit)}
            className={target?.unit === u.unit ? "text-block is-target" : "text-block"}
            tabIndex={-1}
            data-unit={u.unit}
          >
            {u.text}
          </p>
        ))}
      </div>
    );
  }

  return (
    <section className="text-viewer" aria-labelledby="text-viewer-title">
      <div className="text-viewer-head">
        <h3 id="text-viewer-title" className="text-viewer-title">
          Testo estratto
        </h3>
        <p className="hint">{note}</p>
      </div>
      {body}
    </section>
  );
}
