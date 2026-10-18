'use client';
import {CalendarClock, Hourglass, Infinity as InfinityIcon} from 'lucide-react';
import {TextField} from './ui/text-field';
import {SelectField} from './ui/select-field';
import {SegmentedControl} from './ui/segmented-control';
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
}: {
  // Unsaved deadline controls
  value: DeadlineValue;
  // Replace the current settings
  onChange: (value: DeadlineValue) => void;
  // One zone for the whole room
  timeZone: string;
  // Disable input during a save
  disabled?: boolean;
}) {
  const [date = '', time = ''] = value.wall.split('T');
  return (
    <section
      aria-label="Срок закрытия"
      className="space-y-5 rounded-2xl border border-border bg-page/50 p-4 sm:p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium">Срок закрытия</h3>
        <Help label="Срок закрытия">
          Точное время задается в часовом поясе комнаты Отсчет длительности
          начинается при каждом открытии вопроса
        </Help>
      </div>
      <SegmentedControl
        label="Вид срока"
        value={value.deadlineMode}
        disabled={disabled}
        onChange={(mode) =>
          onChange({
            ...value,
            deadlineMode: mode as DeadlineValue['deadlineMode'],
          })
        }
        items={[
          {id: 'none', label: 'Без срока', icon: <InfinityIcon />},
          {id: 'absolute', label: 'Дата и время', icon: <CalendarClock />},
          {id: 'duration', label: 'После открытия', icon: <Hourglass />},
        ]}
      />
      {value.deadlineMode === 'absolute' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="deadline-date"
            label="Дата закрытия"
            type="date"
            value={date}
            disabled={disabled}
            onChange={(event) =>
              onChange({...value, wall: `${event.target.value}T${time}`})
            }
          />
          <TextField
            id="deadline-time"
            label="Время закрытия"
            type="time"
            step={1}
            value={time}
            disabled={disabled}
            onChange={(event) =>
              onChange({...value, wall: `${date}T${event.target.value}`})
            }
          />
          <p className="text-xs text-muted sm:col-span-2">
            Часовой пояс комнаты: {timeZone}
          </p>
        </div>
      )}
      {value.deadlineMode === 'duration' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="deadline-duration"
            label="Закрыть через"
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
            id="deadline-unit"
            label="Единица времени"
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
    </section>
  );
}
