"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Modal dialog: focus moves in, Tab stays inside, Escape or a click outside closes, focus returns to the opener. */
export function Dialog({
  title,
  onClose,
  children,
  actions,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const box = ref.current!;
    (
      box.querySelector<HTMLElement>("[data-autofocus]") ??
      box.querySelector<HTMLElement>(FOCUSABLE) ??
      box
    ).focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return e.preventDefault();
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (
          e.shiftKey &&
          (document.activeElement === first || !box.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last || !box.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, []);

  return (
    <div
      className="dlg-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
        {actions && <div className="dlg-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Confirm box with a Cancel and a confirm button. `onConfirm` may throw; its message is shown inside the box. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  disabled,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose} data-autofocus>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "danger" : ""}
            onClick={go}
            disabled={busy || disabled}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error && (
        <div role="alert" className="notice bad" style={{ margin: 0 }}>
          {error}
        </div>
      )}
    </Dialog>
  );
}

/** Same as ConfirmDialog, but with a form body; the submit button is the confirm button. */
export function FormDialog({
  title,
  children,
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  children: ReactNode;
  submitLabel: string;
  onSubmit: (form: FormData) => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSubmit(new FormData(e.currentTarget));
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "failed");
            setBusy(false);
          }
        }}
      >
        {children}
        {error && (
          <div role="alert" className="notice bad" style={{ margin: 0 }}>
            {error}
          </div>
        )}
        <div className="dlg-actions">
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
