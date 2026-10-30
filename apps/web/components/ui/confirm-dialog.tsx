'use client';
import {useI18n} from '../language-provider';
import motion from './motion.module.css';
import {useEffect, useId, useRef, type RefObject} from 'react';
import {Button} from './button';
// Confirm an action before changing saved data
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  cancelLabel = 'Отмена',
  busyLabel = 'Сохраняем…',
  busy,
  error,
  onConfirm,
  onClose,
  returnFocusRef,
}: {
  // Dialog heading
  title: string;
  // Effect of the action
  description: string;
  // Text for the final action
  confirmLabel: string;
  // Optional label for keeping the current work
  cancelLabel?: string;
  // Short text while the action runs
  busyLabel?: string;
  // Whether the action is running
  busy: boolean;
  // Error from the last save
  error?: string;
  // Run the chosen action
  onConfirm: () => void;
  // An async opener can lose native focus before the dialog appears
  returnFocusRef?: RefObject<HTMLElement | null>;
  // Return without changing data
  onClose: () => void;
}) {
  const {t} = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const descriptionId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous =
      returnFocusRef?.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    element?.showModal();
    cancel.current?.focus();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, [returnFocusRef]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      aria-describedby={descriptionId}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            'button:not([disabled])',
          ),
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        // Keep keyboard focus inside the modal in every supported engine
        if (!first) {
          event.preventDefault();
          event.currentTarget.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === event.currentTarget)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className={`${motion.dialog} m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-panel p-6 text-ink shadow-xl backdrop:bg-black/50`}
    >
      <h2 id={heading} className="text-xl font-semibold">
        {title}
      </h2>
      <p id={descriptionId} className="mt-3 text-sm leading-6 text-muted">
        {description}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-error-ink">
          {t(error)}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button
          ref={cancel}
          variant="secondary"
          disabled={busy}
          onClick={onClose}
        >
          {t(cancelLabel)}
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {t(busy ? busyLabel : confirmLabel)}
        </Button>
      </div>
    </dialog>
  );
}
