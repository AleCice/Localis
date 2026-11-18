import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

interface DialogProps {
  open: boolean;
  /** Called on Esc or any explicit dismissal. */
  onClose: () => void;
  labelledBy: string;
  describedBy?: string;
  /** Element focused when the dialog opens (defaults to the first focusable). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Element to focus after closing; falls back to the element focused before opening. */
  finalFocus?: () => HTMLElement | null;
  /** While true, Esc is ignored (e.g. during a pending request). */
  dismissDisabled?: boolean;
  className?: string;
  role?: "dialog" | "alertdialog";
  children: ReactNode;
}

/**
 * Modal dialog on top of the native <dialog> element: showModal() provides the
 * top layer, inert background and focus containment; we add initial focus,
 * Esc handling and focus return.
 */
export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  finalFocus,
  dismissDisabled = false,
  className,
  role,
  children,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const finalFocusRef = useRef(finalFocus);
  finalFocusRef.current = finalFocus;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      const target =
        initialFocusRef?.current ??
        dialog.querySelector<HTMLElement>("input, textarea, select, button:not([disabled]), [tabindex]");
      target?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      const preferred = finalFocusRef.current?.();
      const fallback = returnTo.current;
      const target = preferred ?? (fallback && fallback.isConnected ? fallback : null);
      target?.focus();
      returnTo.current = null;
    }
  }, [open, initialFocusRef]);

  // Close the native dialog if the component unmounts while open.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const dismiss = () => {
    if (!dismissDisabled) onClose();
  };

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : "dialog"}
      role={role}
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        // Keep React state as the single source of truth.
        event.preventDefault();
        dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      {open ? children : null}
    </dialog>
  );
}
