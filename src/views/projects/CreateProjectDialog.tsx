import { useRef, useState, type FormEvent } from "react";
import type { AppError, Project } from "../../api/types";
import { DESCRIPTION_MAX, NAME_MAX } from "../../api/types";
import { Dialog } from "../../components/Dialog";
import { ErrorBanner } from "../../components/ErrorBanner";
import { Spinner } from "../../components/Spinner";
import { charCount } from "../../lib/format";
import { optionId } from "./ProjectList";

type Field = "name" | "description";

interface CreateProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; description: string | null }) => Promise<Project>;
  onCreated: (project: Project) => void;
  /** Focus target after closing when the opener no longer exists (e.g. onboarding). */
  fallbackFocus?: () => HTMLElement | null;
}

/** Show the character counter only when the value approaches the limit. */
const nearLimit = (count: number, max: number) => count >= Math.floor(max * 0.85);

export function CreateProjectDialog({ open, onClose, onSubmit, onCreated, fallbackFocus }: CreateProjectDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);
  const createdId = useRef<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  const reset = () => {
    setName("");
    setDescription("");
    setFieldErrors({});
    setFormError(null);
    setBusy(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const focusField = (field: Field) => {
    // Wait for aria-invalid/describedby to render before moving focus.
    requestAnimationFrame(() => (field === "name" ? nameRef.current : descriptionRef.current)?.focus());
  };

  const showFieldError = (field: Field, message: string) => {
    setFieldErrors({ [field]: message });
    setFormError(null);
    focusField(field);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return showFieldError("name", "Inserisci un nome.");
    if (charCount(trimmed) > NAME_MAX)
      return showFieldError("name", `Il nome può avere al massimo ${NAME_MAX} caratteri.`);
    if (charCount(description.trim()) > DESCRIPTION_MAX)
      return showFieldError("description", `La descrizione può avere al massimo ${DESCRIPTION_MAX} caratteri.`);

    setBusy(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const project = await onSubmit({ name: trimmed, description: description.trim() || null });
      createdId.current = project.id;
      onCreated(project);
      reset();
    } catch (err) {
      const error = err as AppError;
      setBusy(false);
      if (error.field === "name" || error.field === "description") {
        showFieldError(error.field, error.message);
      } else {
        setFormError(error);
      }
    }
  };

  const nameCount = charCount(name);
  const descriptionCount = charCount(description);
  const showNameCount = nearLimit(nameCount, NAME_MAX);
  const showDescriptionCount = nearLimit(descriptionCount, DESCRIPTION_MAX);
  const describe = (...ids: (string | false)[]) => ids.filter(Boolean).join(" ") || undefined;

  return (
    <Dialog
      open={open}
      onClose={close}
      labelledBy="create-project-title"
      initialFocusRef={nameRef}
      dismissDisabled={busy}
      fallbackFocus={fallbackFocus}
      finalFocus={() => {
        const id = createdId.current;
        createdId.current = null;
        return id ? document.getElementById(optionId(id)) : null;
      }}
    >
      <form className="dialog-body" onSubmit={submit} noValidate aria-busy={busy}>
        <h2 id="create-project-title" className="dialog-title">
          Nuovo progetto
        </h2>

        {formError ? <ErrorBanner error={formError} /> : null}

        <div className="field">
          <label htmlFor="project-name">Nome</label>
          <input
            ref={nameRef}
            id="project-name"
            name="name"
            type="text"
            autoComplete="off"
            required
            aria-required="true"
            value={name}
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={describe(!!fieldErrors.name && "project-name-error", showNameCount && "project-name-count")}
            onChange={(e) => {
              setName(e.target.value);
              if (fieldErrors.name) setFieldErrors((prev) => ({ ...prev, name: undefined }));
            }}
          />
          <div className="field-foot">
            {fieldErrors.name ? (
              <p id="project-name-error" className="field-error">
                {fieldErrors.name}
              </p>
            ) : null}
            {showNameCount ? (
              <p id="project-name-count" className={nameCount > NAME_MAX ? "counter over" : "counter"}>
                {nameCount}/{NAME_MAX}
              </p>
            ) : null}
          </div>
        </div>

        <div className="field">
          <label htmlFor="project-description">
            Descrizione <span className="optional">(facoltativa)</span>
          </label>
          <textarea
            ref={descriptionRef}
            id="project-description"
            name="description"
            rows={4}
            value={description}
            aria-invalid={fieldErrors.description ? true : undefined}
            aria-describedby={describe(
              !!fieldErrors.description && "project-description-error",
              showDescriptionCount && "project-description-count",
            )}
            onChange={(e) => {
              setDescription(e.target.value);
              if (fieldErrors.description) setFieldErrors((prev) => ({ ...prev, description: undefined }));
            }}
          />
          <div className="field-foot">
            {fieldErrors.description ? (
              <p id="project-description-error" className="field-error">
                {fieldErrors.description}
              </p>
            ) : null}
            {showDescriptionCount ? (
              <p
                id="project-description-count"
                className={descriptionCount > DESCRIPTION_MAX ? "counter over" : "counter"}
              >
                {descriptionCount}/{DESCRIPTION_MAX}
              </p>
            ) : null}
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>
            Annulla
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : null}
            Crea progetto
          </button>
        </div>
      </form>
    </Dialog>
  );
}
