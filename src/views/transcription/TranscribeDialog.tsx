import { useEffect, useId, useState } from "react";
import { api } from "../../api/client";
import type { AppError, DocumentVersion, Job, TranscriptionLanguage, WhisperModel, WhisperModelId } from "../../api/types";
import { toAppError } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { downloadPercent, progressStep, useWhisperModels } from "../../hooks/useWhisperModels";
import { formatBytes } from "../../lib/format";
import { readPref, STORAGE_KEYS, writePref } from "../../lib/storage";
import { LANGUAGE_OPTIONS } from "../library/labels";
import { ModelDownloadDialog } from "./ModelDownloadDialog";

const MODEL_IDS: WhisperModelId[] = ["tiny", "base", "small", "large-v3-turbo-q5"];
const LANGUAGES = LANGUAGE_OPTIONS.map((o) => o.value);

interface TranscribeDialogProps {
  open: boolean;
  title: string;
  version: DocumentVersion;
  onClose: () => void;
  onStarted: (job: Job) => void;
}

export function TranscribeDialog(props: TranscribeDialogProps) {
  const id = useId();
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      labelledBy={`${id}-title`}
      describedBy={`${id}-desc`}
      className="dialog-wide"
    >
      {props.open ? <TranscribeForm {...props} titleId={`${id}-title`} descId={`${id}-desc`} /> : null}
    </Dialog>
  );
}

function TranscribeForm({
  title,
  version,
  onClose,
  onStarted,
  titleId,
  descId,
}: TranscribeDialogProps & { titleId: string; descId: string }) {
  const store = useWhisperModels();
  const [model, setModel] = useState<WhisperModelId | null>(() =>
    readPref<WhisperModelId | "">(STORAGE_KEYS.transcriptionModel, ["", ...MODEL_IDS], "") || null,
  );
  const [language, setLanguage] = useState<TranscriptionLanguage>(() =>
    readPref(STORAGE_KEYS.transcriptionLanguage, LANGUAGES, "auto"),
  );
  const [confirming, setConfirming] = useState<WhisperModel | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  const installed = store.models?.filter((m) => m.installed) ?? [];
  const selected = installed.find((m) => m.id === model) ?? null;

  // Default to an installed model once the list is known (the remembered one if still installed).
  useEffect(() => {
    if (!store.models) return;
    if (!selected && installed.length > 0) setModel(installed[0]!.id);
  }, [store.models, selected, installed]);

  const start = async () => {
    if (!selected || starting) return;
    setStarting(true);
    setError(null);
    try {
      const job = await api.startTranscription(version.id, selected.id, language);
      writePref(STORAGE_KEYS.transcriptionModel, selected.id);
      writePref(STORAGE_KEYS.transcriptionLanguage, language);
      onStarted(job);
    } catch (err) {
      setError(toAppError(err));
      setStarting(false);
    }
  };

  const announcements = (store.models ?? [])
    .filter((m) => m.download)
    .map((m) => `${m.name}: scaricamento ${progressStep(downloadPercent(m)) ?? 0} %.`)
    .join(" ");

  return (
    <form
      className="dialog-body"
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <h2 id={titleId} className="dialog-title">
        Trascrivi «{title}»
      </h2>
      <div id={descId} className="dialog-text">
        <p>
          La trascrizione avviene su questo computer con Whisper e può richiedere diversi minuti. Il risultato è
          automatico e può contenere errori.
        </p>
        {version.transcription ? (
          <p>La trascrizione attuale resta disponibile finché quella nuova non è completa.</p>
        ) : null}
      </div>

      {store.loadError ? (
        <ErrorBanner error={store.loadError} action={{ label: "Riprova", onClick: store.reload }} />
      ) : null}
      {store.actionError ? <ErrorBanner error={store.actionError} /> : null}
      <p className="visually-hidden" role="status">
        {announcements}
      </p>

      {store.models === null && !store.loadError ? (
        <p className="loading" role="status">
          <Spinner />
          Caricamento dei modelli…
        </p>
      ) : null}

      {store.models ? (
        <fieldset className="field model-choices">
          <legend className="settings-subtitle">Modello</legend>
          {installed.length === 0 ? (
            <p className="hint">Nessun modello installato: scaricane uno per iniziare (serve una sola volta).</p>
          ) : null}
          {store.models.map((m) => {
            const percent = downloadPercent(m);
            return (
              <div key={m.id} className="model-choice">
                <label className="radio-row">
                  <input
                    type="radio"
                    name={`${titleId}-model`}
                    value={m.id}
                    checked={selected?.id === m.id}
                    disabled={!m.installed}
                    onChange={() => setModel(m.id)}
                  />
                  <span>
                    {m.name}
                    <span className="radio-hint hint">
                      {formatBytes(m.sizeBytes)} · {m.installed ? "installato" : m.download ? `scaricamento ${percent ?? 0} %` : "non installato"}
                    </span>
                  </span>
                </label>
                {m.installed ? null : m.download ? (
                  <span className="model-choice-action">
                    <progress max={100} value={percent ?? undefined} aria-label={`Scaricamento di ${m.name}`} />
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => void store.cancel(m.id).catch(() => undefined)}
                      aria-label={`Annulla lo scaricamento di ${m.name}`}
                    >
                      Annulla
                    </button>
                  </span>
                ) : (
                  <span className="model-choice-action">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setConfirming(m)}
                      aria-label={`Scarica ${m.name} (${formatBytes(m.sizeBytes)})`}
                    >
                      Scarica ({formatBytes(m.sizeBytes)})
                    </button>
                  </span>
                )}
                {m.error ? <span className="field-error">{m.error}</span> : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}

      <div className="field">
        <label htmlFor={`${titleId}-language`}>Lingua del parlato</label>
        <select
          id={`${titleId}-language`}
          className="select"
          value={language}
          onChange={(e) => setLanguage(e.target.value as TranscriptionLanguage)}
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {error ? <ErrorBanner error={error} /> : null}

      <div className="dialog-actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Annulla
        </button>
        <button type="submit" className="btn btn-primary" disabled={!selected || starting} aria-busy={starting}>
          {starting ? <Spinner /> : null}
          Avvia la trascrizione
        </button>
      </div>

      <ModelDownloadDialog
        model={confirming}
        onCancel={() => setConfirming(null)}
        onConfirm={async (m) => {
          await store.download(m.id);
          setConfirming(null);
        }}
      />
    </form>
  );
}
