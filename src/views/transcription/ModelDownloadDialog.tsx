import type { WhisperModel } from "../../api/types";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { formatBytes } from "../../lib/format";

export const MODEL_HOST = "huggingface.co";

interface ModelDownloadDialogProps {
  model: WhisperModel | null;
  onCancel: () => void;
  onConfirm: (model: WhisperModel) => Promise<void>;
  focusAfterConfirm?: () => HTMLElement | null;
}

/** Explicit confirmation before any model download: states host and size. */
export function ModelDownloadDialog({ model, onCancel, onConfirm, focusAfterConfirm }: ModelDownloadDialogProps) {
  const size = model ? formatBytes(model.sizeBytes) : "";
  return (
    <ConfirmDialog
      open={model !== null}
      title={`Scaricare ${model?.name ?? ""}?`}
      confirmLabel={`Scarica (${size})`}
      danger={false}
      onCancel={onCancel}
      onConfirm={() => (model ? onConfirm(model) : Promise.resolve())}
      focusAfterConfirm={focusAfterConfirm}
    >
      <p>
        Localis scaricherà il file <code>{model?.fileName}</code> ({size}) da <strong>{MODEL_HOST}</strong> e ne
        verificherà l'integrità (SHA-256).
      </p>
      <p>
        Il download contatta solo {MODEL_HOST} e non invia nessun tuo dato. La trascrizione avverrà poi su questo
        computer.
      </p>
    </ConfirmDialog>
  );
}
