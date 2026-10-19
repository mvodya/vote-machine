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
  const waiting = state === 'scheduled';
  const open = state === 'open';
  const label = waiting
    ? 'Ожидание открытия'
    : open
      ? 'Закрыть вопрос'
      : 'Открыть вопрос';
  return (
    <Button
      variant={waiting ? 'waiting' : open ? 'negative' : 'positive'}
      title={label}
      aria-label={
        name
          ? `${waiting ? 'Ожидание открытия' : open ? 'Закрыть' : 'Открыть'} вопрос: ${name}`
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
