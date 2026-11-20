import { useEffect, useId, useRef, useState } from "react";
import type { AppError, LlmSettings, ModelRef, Project } from "../../api/types";
import { toAppError } from "../../api/types";
import { ErrorBanner } from "../../components/ErrorBanner";
import { GroupedSelect } from "../../components/GroupedSelect";
import { ArrowDownIcon, ArrowUpIcon, CloseIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { priceFor, providerInfo, useCloud } from "../../hooks/useCloud";
import { embeddingStateLabel, useEmbeddingStatus } from "../../hooks/useEmbeddingStatus";
import type { LlmStore } from "../../hooks/useLlm";
import { isCloud, parseRefKey, providerName, refKey, refLabel, sameRef } from "../../lib/models";
import { buildModelGroups } from "../modelOptions";

const NONE = "";

/** «Modelli e instradamento»: chat model or automatic routing (PRISM), embedding model, indexing state. */
export function ModelsSection({ llm, project }: { llm: LlmStore; project: Project | null }) {
  const { settings, status } = llm;
  const cloud = useCloud();
  const chatId = useId();
  const embId = useId();
  const addId = useId();
  const [saveError, setSaveError] = useState<AppError | null>(null);
  const [saved, setSaved] = useState("");
  const [adding, setAdding] = useState("");
  // Focus follows a candidate moved with the keyboard.
  const [focusTarget, setFocusTarget] = useState<{ key: string; dir: "up" | "down" } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const embeddingKey = settings?.embeddingModel ? refKey(settings.embeddingModel) : null;
  const embedding = useEmbeddingStatus(settings ? (project?.id ?? null) : null, embeddingKey);

  useEffect(() => {
    if (!focusTarget) return;
    const { key, dir } = focusTarget;
    const preferred = buttons.current.get(`${key}|${dir}`);
    const other = buttons.current.get(`${key}|${dir === "up" ? "down" : "up"}`);
    (preferred && !preferred.disabled ? preferred : other)?.focus();
    setFocusTarget(null);
  }, [focusTarget, settings?.autoModels]);

  if (!settings) return null;

  const save = async (next: LlmSettings, what: string) => {
    setSaveError(null);
    setSaved("");
    try {
      await llm.save(next);
      setSaved(what);
      return true;
    } catch (err) {
      setSaveError(toAppError(err));
      return false;
    }
  };

  const chatGroups = buildModelGroups({
    purpose: "chat",
    status,
    cloud,
    configured: [settings.chatModel, ...settings.autoModels],
  });
  const embeddingGroups = buildModelGroups({
    purpose: "embedding",
    status,
    cloud,
    configured: [settings.embeddingModel],
  });
  const candidates = settings.autoModels;
  const addGroups = chatGroups.map((g) => ({
    ...g,
    options: g.options.filter((o) => !candidates.some((c) => refKey(c) === o.value)),
  }));

  const move = async (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= candidates.length) return;
    const next = [...candidates];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    if (await save({ ...settings, autoModels: next }, "Ordine dei candidati salvato.")) {
      setFocusTarget({ key: refKey(item!), dir: delta < 0 ? "up" : "down" });
    }
  };

  const remove = async (ref: ModelRef) => {
    const next = candidates.filter((c) => !sameRef(c, ref));
    await save({ ...settings, autoModels: next }, `${refLabel(ref)} rimosso dai candidati.`);
  };

  const add = async () => {
    const ref = parseRefKey(adding);
    if (!ref) return;
    if (await save({ ...settings, autoModels: [...candidates, ref] }, `${refLabel(ref)} aggiunto ai candidati.`))
      setAdding("");
  };

  const cloudEmbedding = isCloud(settings.embeddingModel) ? settings.embeddingModel : null;

  return (
    <section className="settings-group models-settings" aria-labelledby="models-settings-title">
      <h2 id="models-settings-title" className="settings-title">
        Modelli e instradamento
      </h2>

      <fieldset className="field">
        <legend className="settings-subtitle">Instradamento</legend>
        <div className="segmented">
          {(["manual", "auto"] as const).map((mode) => (
            <label key={mode} className="segmented-option">
              <input
                type="radio"
                name="routing"
                value={mode}
                checked={settings.routing === mode}
                onChange={() =>
                  void save(
                    { ...settings, routing: mode },
                    mode === "auto" ? "Instradamento automatico attivato." : "Instradamento manuale attivato.",
                  )
                }
              />
              <span>{mode === "manual" ? "Manuale" : "Automatico"}</span>
            </label>
          ))}
        </div>
        <p className="hint">
          {settings.routing === "manual"
            ? "Ogni domanda usa il modello di chat scelto qui o nella chat."
            : "Per ogni domanda: il primo modello locale disponibile; altrimenti il modello cloud più economico (con prezzo impostato), poi gli altri nell'ordine. Nei progetti «Solo locale» solo modelli locali."}
        </p>
      </fieldset>

      {settings.routing === "manual" ? (
        <div className="field">
          <label htmlFor={chatId}>Modello di chat</label>
          <GroupedSelect
            id={chatId}
            className="select"
            value={settings.chatModel ? refKey(settings.chatModel) : NONE}
            placeholder="Scegli un modello"
            groups={chatGroups}
            onChange={(value) => {
              const ref = parseRefKey(value);
              if (ref) void save({ ...settings, chatModel: ref }, "Modello di chat salvato.");
            }}
          />
          {isCloud(settings.chatModel) ? (
            <p className="hint">Modello cloud: ogni domanda mostra prima cosa verrà inviato e chiede conferma.</p>
          ) : null}
        </div>
      ) : (
        <div className="field">
          <h3 id={`${addId}-title`} className="settings-subtitle">
            Candidati, in ordine di preferenza
          </h3>
          {candidates.length === 0 ? (
            <p className="hint">Nessun candidato: aggiungi almeno un modello.</p>
          ) : (
            <ol className="candidate-order" aria-labelledby={`${addId}-title`}>
              {candidates.map((ref, index) => {
                const key = refKey(ref);
                const info = isCloud(ref) ? providerInfo(cloud, ref.provider) : null;
                const notes = [
                  ref.provider === "lmstudio" ? "locale" : "cloud",
                  info && !info.hasKey ? "nessuna chiave" : null,
                  isCloud(ref) && cloud.prices && !priceFor(cloud, ref) ? "senza prezzo" : null,
                ].filter(Boolean);
                const label = refLabel(ref);
                return (
                  <li key={key} className="candidate-row">
                    <span className="candidate-pos" aria-hidden="true">
                      {index + 1}.
                    </span>
                    <span className="candidate-name">
                      {label}
                      <span className="muted"> · {notes.join(" · ")}</span>
                    </span>
                    <span className="candidate-actions">
                      <button
                        ref={(el) => {
                          if (el) buttons.current.set(`${key}|up`, el);
                          else buttons.current.delete(`${key}|up`);
                        }}
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={`Sposta su ${label}`}
                        title="Sposta su"
                        disabled={index === 0}
                        onClick={() => void move(index, -1)}
                      >
                        <ArrowUpIcon />
                      </button>
                      <button
                        ref={(el) => {
                          if (el) buttons.current.set(`${key}|down`, el);
                          else buttons.current.delete(`${key}|down`);
                        }}
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={`Sposta giù ${label}`}
                        title="Sposta giù"
                        disabled={index === candidates.length - 1}
                        onClick={() => void move(index, 1)}
                      >
                        <ArrowDownIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn-sm"
                        aria-label={`Rimuovi ${label} dai candidati`}
                        title="Rimuovi"
                        onClick={() => void remove(ref)}
                      >
                        <CloseIcon />
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
          <div className="inline-row">
            <label htmlFor={addId} className="visually-hidden">
              Modello da aggiungere ai candidati
            </label>
            <GroupedSelect
              id={addId}
              className="select grow"
              value={adding}
              placeholder="Modello da aggiungere…"
              groups={addGroups}
              onChange={setAdding}
            />
            <button type="button" className="btn btn-secondary" disabled={!adding} onClick={() => void add()}>
              Aggiungi
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor={embId}>Modello di embedding</label>
        <GroupedSelect
          id={embId}
          className="select"
          value={settings.embeddingModel ? refKey(settings.embeddingModel) : NONE}
          leading={[{ value: NONE, label: "Nessuno — solo ricerca lessicale" }]}
          groups={embeddingGroups}
          aria-describedby={`${embId}-hint`}
          onChange={(value) => {
            const ref = value === NONE ? null : parseRefKey(value);
            void save({ ...settings, embeddingModel: ref }, "Modello di embedding salvato.");
          }}
        />
        <p id={`${embId}-hint`} className="hint">
          Con un modello di embedding la ricerca considera anche il significato dei passaggi, oltre alle parole. Un
          modello cloud riceve il testo dei passaggi: serve il consenso di ciascun progetto (Progetti → Uso del cloud).
        </p>
      </div>
      {saveError ? <ErrorBanner error={saveError} /> : null}
      <p className="hint" role="status">
        {saved}
      </p>

      <div className="embedding-status">
        <h3 className="settings-subtitle">Indicizzazione semantica{project ? ` · ${project.name}` : ""}</h3>
        {!project ? (
          <p className="hint">Seleziona un progetto per vedere lo stato dell'indicizzazione.</p>
        ) : embedding.error ? (
          <ErrorBanner error={embedding.error} />
        ) : embedding.status ? (
          <>
            <p>
              {embeddingStateLabel(embedding.status)}
              {embedding.status.state === "running" ? <Spinner /> : null}
            </p>
            {embedding.status.state !== "disabled" ? (
              <p className="muted">
                Passaggi indicizzati: {embedding.status.embedded} di {embedding.status.total}
                {embedding.status.model
                  ? ` · ${embedding.status.provider && embedding.status.provider !== "lmstudio" ? `${providerName(embedding.status.provider)} · ` : ""}${embedding.status.model}`
                  : ""}
              </p>
            ) : null}
            {embedding.status.state === "needs_consent" && cloudEmbedding ? (
              <p className="hint">
                {project.cloudPolicy === "local_only"
                  ? `«${project.name}» è un progetto «Solo locale»: i suoi passaggi non vengono inviati a ${providerName(cloudEmbedding.provider)}.`
                  : `Per indicizzare «${project.name}» con ${providerName(cloudEmbedding.provider)} dai il consenso in Progetti → Uso del cloud.`}
              </p>
            ) : null}
            {embedding.status.message ? <p className="hint">{embedding.status.message}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
