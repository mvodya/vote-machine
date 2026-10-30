'use client';
import {translate, type Locale} from '../lib/i18n/translate';
import {useI18n} from './language-provider';
import {useDeadlineSounds} from '../lib/use-deadline-sounds';
import {useEffect, useState} from 'react';
import {Hourglass} from 'lucide-react';
import {formatTime, localTimeZone} from '../lib/time';
// Keep long timers readable without hiding seconds near the deadline
export function countdownText(seconds: number, locale: Locale = 'ru') {
  const value = Math.max(0, Math.ceil(seconds));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
  return days
    ? translate(locale, '{value0} д {value1}', {value0: days, value1: clock})
    : clock;
}
// The timer only displays time, PostgreSQL still decides access
export function Countdown({
  at,
  kind = 'close',
  timeZone = localTimeZone(),
}: {
  at?: string | null;
  kind?: 'start' | 'close';
  timeZone?: string;
}) {
  const {t, localeTag, locale} = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);
  useDeadlineSounds(at && kind === 'close' ? [at] : []);
  if (!at || !Number.isFinite(Date.parse(at))) return null;
  const remaining = Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
  const urgent = kind === 'close' && remaining <= 60;
  const ending = kind === 'close' && remaining <= 10 && remaining > 0;
  return (
    <span
      role="timer"
      aria-label={kind === 'start' ? t('До открытия') : t('До закрытия')}
      title={formatTime(at, timeZone, localeTag)}
      className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${kind === 'start' ? 'text-warning-ink' : urgent ? 'text-error-ink' : 'text-muted'} ${ending ? 'motion-safe:animate-deadline-blink' : ''}`}
    >
      <Hourglass
        aria-hidden="true"
        className="size-3.5 shrink-0 motion-safe:animate-hourglass-turn"
      />
      <span>
        {kind === 'start' ? t('До открытия: ') : ''}
        {countdownText(remaining, locale)}
      </span>
    </span>
  );
}
