import { useCallback, useEffect, useId, useState } from "react";
import { api } from "../../api/client";
import type { AppError, CloudEmbeddingEstimate, CloudPolicy, LlmSettings, Project } from "../../api/types";
import { toAppError } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { providerInfo, useCloud } from "../../hooks/useCloud";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { embeddingStateLabel, useEmbeddingStatus } from "../../hooks/useEmbeddingStatus";
import { formatCount, formatMoney, isCloud, providerName, refKey } from "../../lib/models";

export const CLOUD_POLICY_CONFIRM =
  "I dati di questo progetto potranno essere inviati ai provider cloud che sceglierai, sempre dopo una tua conferma.";

function EstimateText({ estimate }: { estimate: CloudEmbeddingEstimate }) {
  if (estimate.chunks === 0) return <>Nessun passaggio da indicizzare.</>;
  return (
    <>
      Da indicizzare: {formatCount(estimate.chunks)} {estimate.chunks === 1 ? "passaggio" : "passaggi"} ·{" "}
      {formatCount(estimate.chars)} caratteri · circa {formatCount(estimate.estTokens)} token (stima) ·{" "}
      {estimate.estCost
        ? `costo stimato ${formatMoney(estimate.estCost)}`
        : "Costo non stimabile: imposta il prezzo in Impostazioni"}
    </>
  );
}

/** «Uso del cloud» in the project detail: policy and consent to cloud indexing. */
export function ProjectCloudSection({ project, onChange }: { project: Project; onChange: (project: Project) => void }) {
  const id = useId();
  const cloud = useCloud();
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [estimate, setEstimate] = useState<CloudEmbeddingEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<AppError | null>(null);
  const [estimating, setEstimating] = useState(false);
  const showEstimating = useDelayedFlag(estimating && estimate === null);
  const [confirmCloud, setConfirmCloud] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [announce, setAnnounce] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => api.getLlmSettings())
      .then(
        (value) => alive && setSettings(value),
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, []);

  const configuredEmbedding = settings?.embeddingModel ?? null;
  const embeddingModel = isCloud(configuredEmbedding) ? configuredEmbedding : null;
  const showIndexing = embeddingModel !== null && project.cloudPolicy === "cloud_allowed";
  const embedding = useEmbeddingStatus(
    showIndexing ? project.id : null,
    embeddingModel ? `${refKey(embeddingModel)}|${project.cloudEmbeddingConsent}` : null,
  );
  const info = embeddingModel ? providerInfo(cloud, embeddingModel.provider) : null;
  const name = embeddingModel ? (info?.name ?? providerName(embeddingModel.provider)) : "";

  const loadEstimate = useCallback(async () => {
    setEstimating(true);
    setEstimateError(null);
    try {
      setEstimate(await Promise.resolve().then(() => api.estimateCloudEmbedding(project.id)));
    } catch (err) {
      setEstimateError(toAppError(err));
    } finally {
      setEstimating(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (showIndexing) void loadEstimate();
  }, [showIndexing, project.cloudEmbeddingConsent, loadEstimate]);

  const setPolicy = async (policy: CloudPolicy) => {
    const updated = await api.setProjectCloudPolicy(project.id, policy);
    onChange(updated);
    return updated;
  };

  const chooseLocal = async () => {
    if (project.cloudPolicy === "local_only" || busy) return;
    setBusy(true);
    setError(null);
    try {
      const hadConsent = project.cloudEmbeddingConsent;
      await setPolicy("local_only");
      setAnnounce(
        hadConsent
          ? "Progetto impostato su «Solo locale». Il consenso all'indicizzazione cloud è stato revocato."
          : "Progetto impostato su «Solo locale».",
      );
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await api.setCloudEmbeddingConsent(project.id, false));
      setAnnounce(`Consenso revocato: i passaggi di «${project.name}» non vengono più inviati a ${name}.`);
    } catch (err) {
      setError(toAppError(err));
    } finally {
      setBusy(false);
    }
  };

  const cloudAllowed = project.cloudPolicy === "cloud_allowed";

  return (
    <div className="project-cloud">
      <fieldset className="field cloud-policy" disabled={busy}>
        <legend className="settings-subtitle">Uso del cloud</legend>
        <label className="radio-row">
          <input
            type="radio"
            name={`${id}-policy`}
            checked={!cloudAllowed}
            onChange={() => void chooseLocal()}
            aria-describedby={`${id}-local-hint`}
          />
          <span>
            Solo locale
            <span id={`${id}-local-hint`} className="hint radio-hint">
              Nessun dato del progetto lascia questo computer: si usano solo i modelli di LM Studio.
            </span>
          </span>
        </label>
        <label className="radio-row">
          <input
            type="radio"
            name={`${id}-policy`}
            checked={cloudAllowed}
            onChange={() => setConfirmCloud(true)}
            aria-describedby={`${id}-cloud-hint`}
          />
          <span>
            Consenti cloud
            <span id={`${id}-cloud-hint`} className="hint radio-hint">
              Domande e passaggi possono andare ai provider cloud, solo dopo che hai visto e confermato cosa viene
              inviato.
            </span>
          </span>
        </label>
      </fieldset>
      {error ? <ErrorBanner error={error} action={{ label: "Chiudi", onClick: () => setError(null) }} /> : null}

      {embeddingModel ? (
        <section className="cloud-indexing" aria-labelledby={`${id}-indexing`}>
          <h3 id={`${id}-indexing`} className="settings-subtitle">
            Indicizzazione cloud
          </h3>
          <p className="hint">
            Il modello di embedding configurato è {name} · {embeddingModel.model}
            {info ? ` (${info.host})` : ""}.
          </p>
          {!cloudAllowed ? (
            <p>Il progetto è «Solo locale»: i suoi passaggi non vengono inviati e la ricerca resta lessicale.</p>
          ) : (
            <>
              {estimateError ? (
                <ErrorBanner error={estimateError} action={{ label: "Riprova", onClick: () => void loadEstimate() }} />
              ) : null}
              {estimate && (!project.cloudEmbeddingConsent || estimate.chunks > 0) ? (
                <p className="muted">
                  <EstimateText estimate={estimate} />
                </p>
              ) : showEstimating ? (
                <p className="loading" role="status">
                  <Spinner />
                  Stima in corso…
                </p>
              ) : null}
              {project.cloudEmbeddingConsent ? (
                <>
                  <p>Consenso dato: i passaggi di questo progetto vengono indicizzati con {name}.</p>
                  {embedding.status ? (
                    <p className="muted">
                      Indicizzazione: {embeddingStateLabel(embedding.status)}
                      {embedding.status.state !== "disabled"
                        ? ` · ${embedding.status.embedded} di ${embedding.status.total} passaggi`
                        : ""}
                      {embedding.status.state === "running" ? <Spinner /> : null}
                    </p>
                  ) : null}
                  {embedding.status?.message ? <p className="hint">{embedding.status.message}</p> : null}
                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void revoke()}
                      disabled={busy}
                    >
                      Revoca consenso
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>Senza consenso la ricerca di questo progetto resta lessicale e nessun passaggio viene inviato.</p>
                  <div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        setConsentOpen(true);
                        void loadEstimate();
                      }}
                      disabled={busy}
                    >
                      Consenti indicizzazione cloud…
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      ) : null}
      <p className="visually-hidden" role="status">
        {announce}
      </p>

      <ConfirmDialog
        open={confirmCloud}
        title={`Consentire il cloud per «${project.name}»?`}
        confirmLabel="Consenti cloud"
        danger={false}
        onCancel={() => setConfirmCloud(false)}
        onConfirm={async () => {
          await setPolicy("cloud_allowed");
          setConfirmCloud(false);
          setAnnounce("Cloud consentito per questo progetto.");
        }}
      >
        <p>{CLOUD_POLICY_CONFIRM}</p>
        <p>Puoi tornare a «Solo locale» in qualsiasi momento.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={consentOpen && embeddingModel !== null}
        title={`Indicizzare «${project.name}» con ${name}?`}
        confirmLabel={`Consenti e invia a ${name}`}
        danger={false}
        onCancel={() => setConsentOpen(false)}
        onConfirm={async () => {
          onChange(await api.setCloudEmbeddingConsent(project.id, true));
          setConsentOpen(false);
          setAnnounce(`Consenso dato: i passaggi di «${project.name}» verranno indicizzati con ${name}.`);
        }}
      >
        <dl className="consent-facts">
          <div>
            <dt>Provider</dt>
            <dd>
              {name}
              {info ? ` · ${info.host}` : ""}
            </dd>
          </div>
          <div>
            <dt>Modello</dt>
            <dd>{embeddingModel?.model}</dd>
          </div>
          <div>
            <dt>Cosa viene inviato</dt>
            <dd>
              Il testo dei passaggi estratti dai documenti di questo progetto, anche di quelli che importerai in
              seguito, e il testo delle tue domande per la ricerca semantica. I file originali non vengono inviati.
            </dd>
          </div>
          <div>
            <dt>Stima</dt>
            <dd>
              {estimate ? <EstimateText estimate={estimate} /> : estimating ? "Stima in corso…" : "Non disponibile."}
            </dd>
          </div>
        </dl>
        <p>Puoi revocare il consenso in qualsiasi momento; i vettori già calcolati restano su questo computer.</p>
      </ConfirmDialog>
    </div>
  );
}
