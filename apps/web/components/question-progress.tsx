'use client';
import type {ReactNode} from 'react';
import {useI18n} from './language-provider';
import {Countdown} from './countdown';

// Keep the current question header the same in every ballot view
export function QuestionProgress({
  pending,
  at,
  kind,
  timeZone,
  children,
}: {
  // Missing progress means the snapshot is still loading
  pending?: number;
  // Optional opening or closing timer
  at?: string | null;
  kind: 'start' | 'close';
  timeZone?: string;
  // Review mode adds its close button here
  children?: ReactNode;
}) {
  const {t} = useI18n();
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
      <p className="text-sm text-muted">
        {pending === undefined
          ? t('Загружаем вопросы…')
          : t('Осталось вопросов: {value0}', {value0: pending})}
      </p>
      <Countdown at={at} kind={kind} timeZone={timeZone} />
      {children}
    </div>
  );
}
