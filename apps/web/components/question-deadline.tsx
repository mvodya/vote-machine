'use client';
import {CalendarClock, Hourglass, Infinity as InfinityIcon} from 'lucide-react';
import {TemporalField} from './ui/temporal-field';
import {wallTime} from '../lib/time';
import {TextField} from './ui/text-field';
import {SelectField} from './ui/select-field';
import {SegmentedControl} from './ui/segmented-control';
import {Countdown} from './countdown';
import {Help} from './ui/help';

export interface DeadlineValue {
  // No deadline, an absolute wall time or a relative duration
  deadlineMode: 'none' | 'absolute' | 'duration';
  // Shared-zone wall time in the controls
  wall: string;
  // Relative value and display unit
  duration: string;
  unit: string;
}
// Reuse deadline controls in the question workspace
export function QuestionDeadline({
  value,
  onChange,
  timeZone,
  disabled = false,
  purpose = 'close',
  at,
}: {
  purpose?: 'start' | 'close';
  at?: string | null;
  // Unsaved deadline controls
  value: DeadlineValue;
  // Replace the current settings
  onChange: (value: DeadlineValue) => void;
  // One zone for the whole room
  timeZone: string;
  // Disable input during a save
  disabled?: boolean;
}) {
  const start = purpose === 'start';
  const title = start ? 'Время открытия' : 'Срок закрытия';
  const [date = '', time = ''] = value.wall.split('T');
  return (
    <section
      aria-label={title}
      className="space-y-5 rounded-2xl border border-border bg-page/50 p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">{title}</h3>
        <Help label={title}>
          Точное время задается в часовом поясе комнаты
          <span className="mt-2 block">
            {start
              ? 'Отсчет начинается после нажатия «Открыть вопрос»'
              : 'Отсчет начинается при фактическом открытии вопроса'}
          </span>
        </Help>
      </div>
      <SegmentedControl
        label={start ? 'Вид отложенного старта' : 'Вид срока'}
        value={value.deadlineMode}
        disabled={disabled}
        onChange={(mode) =>
          onChange({
            ...value,
            deadlineMode: mode as DeadlineValue['deadlineMode'],
          })
        }
        items={[
          ...(!start
            ? [{id: 'none', label: 'Без срока', icon: <InfinityIcon />}]
            : []),
          {id: 'absolute', label: 'Дата и время', icon: <CalendarClock />},
          {
            id: 'duration',
            label: start ? 'Через время' : 'После открытия',
            icon: <Hourglass />,
          },
        ]}
      />
      {value.deadlineMode === 'absolute' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TemporalField
            id={`${purpose}-date`}
            label={start ? 'Дата открытия' : 'Дата закрытия'}
            kind="date"
            now={() =>
              wallTime(new Date().toISOString(), timeZone).split('T')[0]
            }
            value={date}
            disabled={disabled}
            onChange={(next) => onChange({...value, wall: `${next}T${time}`})}
          />
          <TemporalField
            id={`${purpose}-time`}
            label={start ? 'Время открытия' : 'Время закрытия'}
            kind="time"
            now={() =>
              wallTime(new Date().toISOString(), timeZone).split('T')[1]
            }
            value={time}
            disabled={disabled}
            onChange={(next) => onChange({...value, wall: `${date}T${next}`})}
          />
          <p className="text-xs text-muted sm:col-span-2">
            Часовой пояс комнаты: {timeZone}
          </p>
        </div>
      )}
      {value.deadlineMode === 'duration' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id={`${purpose}-duration`}
            label={start ? 'Открыть через' : 'Закрыть через'}
            type="number"
            min={1}
            step={1}
            value={value.duration}
            disabled={disabled}
            onChange={(event) =>
              onChange({...value, duration: event.target.value})
            }
          />
          <SelectField
            id={`${purpose}-unit`}
            label={start ? 'Единица времени открытия' : 'Единица времени'}
            value={value.unit}
            disabled={disabled}
            onChange={(event) => onChange({...value, unit: event.target.value})}
          >
            <option value="60">Минуты</option>
            <option value="3600">Часы</option>
            <option value="86400">Дни</option>
            <option value="1">Секунды</option>
          </SelectField>
        </div>
      )}
      {start && (
        <p className="text-xs text-muted">
          Вопрос не запустится, пока вы не нажмете «Открыть вопрос»
        </p>
      )}
      {at && (
        <div className="flex justify-end">
          <Countdown at={at} kind={purpose} timeZone={timeZone} />
        </div>
      )}
    </section>
  );
}
