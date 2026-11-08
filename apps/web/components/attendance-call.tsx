'use client';
import {useEffect, useId, useRef} from 'react';
import {BellRing} from 'lucide-react';
import {useI18n} from './language-provider';
import styles from './attendance-call.module.css';
// Close only on the timer, leaving no manual dismissal controls
export function AttendanceCall({
  name,
  duration,
  onDone,
}: {
  // Keep the called person's name visible during attendance checks
  name: string;
  duration: number;
  onDone: () => void;
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
    element.focus({preventScroll: true});
    const timer = setTimeout(onDone, duration);
    return () => {
      clearTimeout(timer);
      element.close();
      if (opener?.isConnected) opener.focus({preventScroll: true});
    };
  }, [duration, onDone]);
  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={heading}
      tabIndex={-1}
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === 'Tab') event.preventDefault();
      }}
      className={`${styles.alert} m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl border-2 border-primary bg-panel p-8 text-center text-ink backdrop:bg-black/60`}
    >
      <BellRing
        aria-hidden="true"
        className="mx-auto mb-5 size-12 text-primary"
      />
      <h2 id={heading} className="text-xl font-semibold">
        {t('Администратор вызывает вас')}
      </h2>
      <p className="mt-4 break-words text-lg">{name}</p>
    </dialog>
  );
}
