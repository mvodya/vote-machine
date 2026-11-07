'use client';
import {ListChecks, TicketCheck} from 'lucide-react';
import {useI18n} from './language-provider';
import {questionTypes, type QuestionType} from '../lib/questions';

// Give each answer kind the same icon and name across the app
export function QuestionTypeLabel({
  kind = 'choice',
  className = '',
}: {
  // Older questions use the ordinary choice kind
  kind?: QuestionType;
  // Menus and quiet metadata share this label
  className?: string;
}) {
  const {t} = useI18n();
  const Icon = kind === 'allocation' ? TicketCheck : ListChecks;
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {t(questionTypes[kind])}
    </span>
  );
}
