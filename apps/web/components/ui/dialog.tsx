'use client';
import {useI18n} from '../language-provider';
import motion from './motion.module.css';
import {useEffect, useId, useRef, type ReactNode} from 'react';
import {X} from 'lucide-react';
import {Button} from './button';
// Keep a small modal on screen and return focus to its opener
export function Dialog({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const {t} = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    const element = dialog.current!;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.showModal();
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled])',
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      className={`${motion.dialog} m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-border bg-panel p-5 text-ink shadow-xl backdrop:bg-black/50 sm:p-6`}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 id={heading} className="text-lg font-semibold">
          {title}
        </h2>
        <Button
          variant="ghost"
          aria-label={t('Закрыть')}
          startIcon={<X />}
          onClick={onClose}
        />
      </div>
      {children}
    </dialog>
  );
}
