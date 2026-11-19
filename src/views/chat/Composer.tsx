import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { CloseIcon } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";

export interface ScopeChip {
  id: string;
  title: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** An answer is being generated: sending is disabled, «Interrompi» is offered. */
  generating: boolean;
  cancelling: boolean;
  onCancel: () => void;
  scope: ScopeChip[];
  onPickScope: () => void;
  onRemoveScope: (id: string) => void;
}

export interface ComposerHandle {
  focus: () => void;
}

export const COMPOSER_INPUT_ID = "chat-composer-input";

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  { value, onChange, onSend, generating, cancelling, onCancel, scope, onPickScope, onRemoveScope },
  ref,
) {
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  // Grow with the content up to a few lines, then scroll inside the field.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const canSend = !generating && value.trim() !== "";

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (canSend) onSend();
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSend();
      }}
    >
      <div className="composer-scope">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onPickScope} aria-haspopup="dialog">
          Limita a documenti…
        </button>
        {scope.length > 0 ? (
          <ul className="chip-list" aria-label="Documenti selezionati">
            {scope.map((chip) => (
              <li key={chip.id} className="chip">
                <span className="chip-label" title={chip.title}>
                  {chip.title}
                </span>
                <button
                  type="button"
                  className="chip-remove"
                  aria-label={`Rimuovi «${chip.title}» dalla selezione`}
                  title="Rimuovi"
                  onClick={() => onRemoveScope(chip.id)}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <span className="hint">Ricerca in tutto il progetto</span>
        )}
      </div>
      <div className="composer-box">
        <label htmlFor={COMPOSER_INPUT_ID} className="visually-hidden">
          Domanda
        </label>
        <textarea
          id={COMPOSER_INPUT_ID}
          ref={input}
          rows={1}
          value={value}
          placeholder="Fai una domanda sui documenti del progetto"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          aria-describedby="chat-composer-hint"
        />
        {generating ? (
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={cancelling} aria-busy={cancelling}>
            {cancelling ? <Spinner /> : null}
            Interrompi
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!canSend}>
            Invia
          </button>
        )}
      </div>
      <p id="chat-composer-hint" className="hint composer-hint">
        Invio per inviare, Maiusc+Invio per andare a capo.
      </p>
    </form>
  );
});
