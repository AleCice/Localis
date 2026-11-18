import type { AppError } from "../api/types";
import { AlertIcon } from "./Icons";

interface ErrorBannerProps {
  error: AppError;
  action?: { label: string; onClick: () => void };
}

/** Non-field error: user-facing message, technical detail only on demand. */
export function ErrorBanner({ error, action }: ErrorBannerProps) {
  return (
    <div className="banner banner-error" role="alert">
      <AlertIcon />
      <div className="banner-body">
        <p className="banner-message">{error.message}</p>
        {error.detail ? (
          <details className="banner-details">
            <summary>Dettagli</summary>
            <pre>{error.detail}</pre>
          </details>
        ) : null}
      </div>
      {action ? (
        <button type="button" className="btn btn-secondary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
