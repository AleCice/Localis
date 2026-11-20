import { useId, useRef } from "react";
import type { CloudPreview } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { formatCount, formatMoney, providerName, refLabel } from "../../lib/models";
import { unitLabel } from "./labels";

interface CloudSendDialogProps {
  preview: CloudPreview | null;
  /** Shown above the details, e.g. when an expired confirmation had to be prepared again. */
  notice: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Binding preview of one cloud request: shown before every question sent to a cloud model. */
export function CloudSendDialog({ preview, notice, onCancel, onConfirm }: CloudSendDialogProps) {
  const id = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const name = preview ? preview.providerName || providerName(preview.route.model.provider) : "";

  return (
    <Dialog
      open={preview !== null}
      onClose={onCancel}
      labelledBy={`${id}-title`}
      describedBy={`${id}-privacy`}
      initialFocusRef={cancelRef}
      className="dialog-wide cloud-send"
    >
      {preview ? (
        <div className="dialog-body">
          <h2 id={`${id}-title`} className="dialog-title">
            Inviare la domanda a {name}?
          </h2>
          {notice ? (
            <p className="notice" role="note">
              {notice}
            </p>
          ) : null}
          <dl className="consent-facts">
            <div>
              <dt>Provider</dt>
              <dd>
                {name} · <span className="mono">{preview.host}</span>
              </dd>
            </div>
            <div>
              <dt>Modello</dt>
              <dd>{preview.route.model.model}</dd>
            </div>
            <div>
              <dt>Scelta del modello</dt>
              <dd>{preview.route.reason}</dd>
            </div>
            <div>
              <dt>Cosa viene inviato</dt>
              <dd>
                <ul className="send-list">
                  <li>
                    La domanda:
                    <blockquote className="send-question">{preview.question}</blockquote>
                  </li>
                  <li>
                    {preview.sources.length === 0
                      ? "Nessun passaggio dei documenti."
                      : preview.sources.length === 1
                        ? "1 passaggio dai documenti del progetto:"
                        : `${preview.sources.length} passaggi dai documenti del progetto:`}
                    {preview.sources.length > 0 ? (
                      <ol className="send-sources" aria-label="Passaggi inviati">
                        {preview.sources.map((s) => (
                          <li key={s.n}>
                            <span className="inspector-rank">[{s.n}]</span> {s.title}, {unitLabel(s.unitKind, s.unit)}{" "}
                            <span className="muted">· {formatCount(s.chars)} caratteri</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </li>
                  <li>
                    {preview.historyPairs === 0
                      ? "Nessuno scambio precedente della conversazione."
                      : `${preview.historyPairs === 1 ? "1 scambio precedente" : `${preview.historyPairs} scambi precedenti`} della conversazione (${formatCount(preview.historyChars)} caratteri).`}
                  </li>
                  <li>Le istruzioni di Localis per il modello (come citare le fonti).</li>
                </ul>
              </dd>
            </div>
            {preview.queryEmbeddedBy ? (
              <div>
                <dt>Già inviato</dt>
                <dd>
                  Per la ricerca semantica la domanda è stata inviata a {refLabel(preview.queryEmbeddedBy)}, con il
                  consenso del progetto.
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Dimensione</dt>
              <dd>
                {formatCount(preview.totalChars)} caratteri · circa {formatCount(preview.estInputTokens)} token in
                ingresso (stima) · al massimo {formatCount(preview.maxOutputTokens)} token in uscita
              </dd>
            </div>
            <div>
              <dt>Costo stimato</dt>
              <dd>
                {preview.estCost
                  ? `da ${formatMoney(preview.estCost.min)} a ${formatMoney(preview.estCost.max)} (stima)`
                  : "Costo non stimabile: imposta il prezzo in Impostazioni"}
              </dd>
            </div>
          </dl>
          <p id={`${id}-privacy`} className="dialog-text">
            Solo il testo elencato viene inviato a {name}, che lo tratta secondo le proprie condizioni. I file originali
            restano su questo computer. La conferma vale solo per questa domanda.
          </p>
          <div className="dialog-actions">
            <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel}>
              Annulla
            </button>
            <button type="button" className="btn btn-primary" onClick={onConfirm}>
              Invia a {name}
            </button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
