'use client';
import {useI18n} from '../language-provider';
import {useState} from 'react';
import {
  CalendarDays,
  Clock,
  ChevronLeft,
  ChevronRight,
  CalendarClock,
} from 'lucide-react';
import {TextField} from './text-field';
import {SelectField} from './select-field';
import {Button} from './button';
import {Popover} from './popover';
// Use the same calendar and time controls in Safari and Chrome
export function TemporalField({
  id,
  label,
  kind,
  value,
  now,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  kind: 'date' | 'time';
  // Values use the room wall clock, never the device offset
  value: string;
  now: () => string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const {t, localeTag} = useI18n();
  const [month, setMonth] = useState(() =>
    (kind === 'date'
      ? /^\d{4}-(0[1-9]|1[0-2])/.test(value)
        ? value
        : now()
      : '2000-01-01'
    ).slice(0, 7),
  );
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  // Keep month navigation independent of a partially typed date
  function move(amount: number) {
    setMonth(
      new Date(Date.UTC(year, number - 1 + amount, 1))
        .toISOString()
        .slice(0, 7),
    );
  }
  const parts = (value || '00:00:00').split(':');
  return (
    <TextField
      id={id}
      label={label}
      type="text"
      value={value}
      disabled={disabled}
      placeholder={kind === 'date' ? t('ГГГГ-ММ-ДД') : t('ЧЧ:ММ:СС')}
      className="pr-24 tabular-nums"
      autoComplete="off"
      pattern={
        kind === 'date'
          ? '[0-9]{4}-[0-9]{2}-[0-9]{2}'
          : '[0-9]{2}:[0-9]{2}(:[0-9]{2})?'
      }
      onChange={(event) => onChange(event.target.value)}
      endAction={
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            disabled={disabled}
            aria-label={
              kind === 'date'
                ? t('Установить текущую дату: {value0}', {value0: label})
                : t('Установить текущее время: {value0}', {value0: label})
            }
            title={
              kind === 'date'
                ? t('Установить текущую дату')
                : t('Установить текущее время')
            }
            onClick={() => onChange(now())}
          >
            <CalendarClock />
          </Button>
          {!disabled && (
            <Popover
              label={t('Выбрать: {value0}', {
                value0: label,
              })}
              className="size-10 text-muted hover:bg-accent"
              trigger={
                kind === 'date' ? (
                  <CalendarDays className="size-4" />
                ) : (
                  <Clock className="size-4" />
                )
              }
            >
              {kind === 'date' ? (
                <>
                  <div className="mb-3 flex items-center justify-between">
                    <Button
                      variant="ghost"
                      aria-label={t('Предыдущий месяц')}
                      onClick={() => move(-1)}
                    >
                      <ChevronLeft />
                    </Button>
                    <span className="font-medium">
                      {new Intl.DateTimeFormat(localeTag, {
                        month: 'long',
                        timeZone: 'UTC',
                      }).format(first)}{' '}
                      {year}
                    </span>
                    <Button
                      variant="ghost"
                      aria-label={t('Следующий месяц')}
                      onClick={() => move(1)}
                    >
                      <ChevronRight />
                    </Button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-center">
                    {[
                      t('Пн'),
                      t('Вт'),
                      t('Ср'),
                      t('Чт'),
                      t('Пт'),
                      t('Сб'),
                      t('Вс'),
                    ].map((day) => (
                      <span key={day} className="py-1 text-muted">
                        {day}
                      </span>
                    ))}
                    {Array.from({length: offset}, (_, i) => (
                      <span key={`gap-${i}`} />
                    ))}
                    {Array.from({length: days}, (_, i) => {
                      const date = `${month}-${String(i + 1).padStart(2, '0')}`;
                      return (
                        <button
                          key={date}
                          type="button"
                          aria-label={date}
                          aria-pressed={value === date}
                          onClick={() => onChange(date)}
                          className="h-9 w-full rounded-lg hover:bg-accent focus-visible:outline-2 focus-visible:outline-primary aria-pressed:bg-primary aria-pressed:text-on-primary"
                        >
                          {i + 1}
                        </button>
                      );
                    })}
                  </div>
                </>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {[t('Часы'), t('Минуты'), t('Секунды')].map((part, index) => (
                    <SelectField
                      key={part}
                      id={`${id}-${index}`}
                      label={part}
                      value={parts[index] || '00'}
                      onChange={(event) => {
                        const next = [
                          parts[0] || '00',
                          parts[1] || '00',
                          parts[2] || '00',
                        ];
                        next[index] = event.target.value;
                        onChange(next.join(':'));
                      }}
                    >
                      {Array.from({length: index === 0 ? 24 : 60}, (_, i) =>
                        String(i).padStart(2, '0'),
                      ).map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </SelectField>
                  ))}
                </div>
              )}
            </Popover>
          )}
        </div>
      }
    />
  );
}
