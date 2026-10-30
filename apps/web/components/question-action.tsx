'use client';
import {useI18n} from './language-provider';
import {Clock3, Play, Square} from 'lucide-react';
import {Button} from './ui/button';
// Keep state colors and labels the same in lists and management
export function QuestionAction({
  state,
  busy,
  onClick,
  name,
  compact = false,
}: {
  state: string;
  busy: boolean;
  onClick: () => void;
  name?: string;
  compact?: boolean;
}) {
  const {t} = useI18n();
  const waiting = state === 'scheduled';
  const open = state === 'open';
  const label = waiting
    ? t('Ожидание открытия')
    : open
      ? t('Закрыть вопрос')
      : t('Открыть вопрос');
  return (
    <Button
      variant={waiting ? 'waiting' : open ? 'negative' : 'positive'}
      title={label}
      aria-label={
        name
          ? t('{value0} вопрос: {value1}', {
              value0: waiting
                ? t('Ожидание открытия')
                : open
                  ? t('Закрыть')
                  : t('Открыть'),
              value1: name,
            })
          : label
      }
      startIcon={waiting ? <Clock3 /> : open ? <Square /> : <Play />}
      disabled={busy || waiting}
      onClick={onClick}
    >
      {!compact && label}
    </Button>
  );
}
