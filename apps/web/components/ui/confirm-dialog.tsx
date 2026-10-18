'use client';
import {useEffect, useId, useRef} from 'react';
import {Button} from './button';

// Confirm actions that replace or block an existing link
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  // Dialog heading
  title: string;
  // Effect of the action
  description: string;
  // Text for the final action
  confirmLabel: string;
  // Whether the action is running
  busy: boolean;
  // Error from the last save
  error?: string;
  // Run the chosen action
  onConfirm: () => void;
  // Return without changing the link
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-border bg-white p-6 text-ink shadow-xl backdrop:bg-ink/25"
    >
      <h2 id={heading} className="text-xl font-semibold">
        {title}
      </h2>
      <p className="mt-3 text-sm leading-6 text-muted">{description}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <div className="mt-6 flex flex-wrap justify-end gap-3">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy} onClick={onConfirm}>
          {busy ? 'Сохраняем…' : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
