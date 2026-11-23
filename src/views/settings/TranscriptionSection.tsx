import { useState } from "react";
import type { WhisperModel } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { downloadPercent, progressStep, useWhisperModels } from "../../hooks/useWhisperModels";
import { formatBytes } from "../../lib/format";
import { MODEL_HOST, ModelDownloadDialog } from "../transcription/ModelDownloadDialog";

const modelRowId = (id: string) => `whisper-model-${id}`;

/** «Trascrizione»: local Whisper models (download on explicit confirmation, cancel, delete). */
export function TranscriptionSection() {
  const store = useWhisperModels();
  const [confirming, setConfirming] = useState<WhisperModel | null>(null);
  const [deleting, setDeleting] = useState<WhisperModel | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const cancel = async (model: WhisperModel) => {
    setBusy(model.id);
    try {
      await store.cancel(model.id);
    } catch {
      /* shown as actionError */
    } finally {
      setBusy(null);
    }
  };

  // One sentence per running download, updated in 10 % steps for screen readers.
  const announcements = (store.models ?? [])
    .filter((m) => m.download)
    .map((m) => `${m.name}: scaricamento ${progressStep(downloadPercent(m)) ?? 0} %.`)
    .join(" ");

  return (
    <section className="settings-group transcription-settings" aria-labelledby="transcription-settings-title">
      <h2 id="transcription-settings-title" className="settings-title">
        Trascrizione
      </h2>
      <p className="hint">
        La trascrizione delle registrazioni avviene su questo computer con Whisper (whisper.cpp): l'audio non lascia il
        computer. Per usarla serve un modello: il download avviene solo quando lo chiedi e contatta solo {MODEL_HOST}.
        I modelli più grandi sono più precisi ma più lenti.
      </p>

      {store.loadError ? (
        <ErrorBanner error={store.loadError} action={{ label: "Riprova", onClick: store.reload }} />
      ) : null}
      {store.actionError ? (
        <ErrorBanner error={store.actionError} action={{ label: "Chiudi", onClick: store.clearActionError }} />
      ) : null}
      <p className="visually-hidden" role="status">
        {announcements}
      </p>

      {store.models === null && !store.loadError ? (
        <p className="loading" role="status">
          <Spinner />
          Caricamento…
        </p>
      ) : null}

      {store.models ? (
        <ul className="whisper-models" aria-label="Modelli Whisper">
          {store.models.map((model) => {
            const percent = downloadPercent(model);
            return (
              <li key={model.id} id={modelRowId(model.id)} className="whisper-model">
                <div className="whisper-model-head">
                  <span className="whisper-model-name">{model.name}</span>
                  <span className="hint">
                    {model.fileName} · {formatBytes(model.sizeBytes)}
                  </span>
                </div>
                <div className="whisper-model-state">
                  {model.installed ? (
                    <span className="status" data-status="extracted">
                      <span className="status-text">Installato</span>
                    </span>
                  ) : model.download ? (
                    <span className="whisper-progress">
                      <progress
                        max={100}
                        value={percent ?? undefined}
                        aria-label={`Scaricamento di ${model.name}`}
                      />
                      <span className="hint">
                        Scaricamento {percent ?? 0} % ({formatBytes(model.download.receivedBytes)} di{" "}
                        {formatBytes(model.download.totalBytes)})
                      </span>
                    </span>
                  ) : (
                    <span className="status" data-status="not_applicable">
                      <span className="status-text">Da scaricare</span>
                    </span>
                  )}
                  {model.error ? <span className="field-error">{model.error}</span> : null}
                </div>
                <div className="whisper-model-actions">
                  {model.installed ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-danger-text"
                      onClick={() => setDeleting(model)}
                      aria-label={`Elimina ${model.name}`}
                    >
                      Elimina
                    </button>
                  ) : model.download ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void cancel(model)}
                      disabled={busy === model.id}
                      aria-label={`Annulla lo scaricamento di ${model.name}`}
                    >
                      Annulla
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setConfirming(model)}
                      aria-label={`Scarica ${model.name} (${formatBytes(model.sizeBytes)})`}
                    >
                      Scarica
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      <ModelDownloadDialog
        model={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={async (model) => {
          await store.download(model.id);
          setConfirming(null);
        }}
        focusAfterConfirm={() =>
          confirming ? (document.getElementById(modelRowId(confirming.id))?.querySelector("button") ?? null) : null
        }
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Eliminare ${deleting?.name ?? ""}?`}
        confirmLabel="Elimina"
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await store.remove(deleting.id);
          setDeleting(null);
        }}
        focusAfterConfirm={() =>
          deleting ? (document.getElementById(modelRowId(deleting.id))?.querySelector("button") ?? null) : null
        }
      >
        <p>
          Il file del modello verrà rimosso da questo computer. Le trascrizioni già fatte restano; per trascrivere di
          nuovo con questo modello dovrai scaricarlo ancora.
        </p>
      </ConfirmDialog>
    </section>
  );
}
