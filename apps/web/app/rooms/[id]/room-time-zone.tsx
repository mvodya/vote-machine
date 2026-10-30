'use client';
import {useI18n} from '../../../components/language-provider';
import {useState} from 'react';
import {SelectField} from '../../../components/ui/select-field';
import {isRoom, type Room} from '../../../lib/rooms';
import {localTimeZone} from '../../../lib/time';
// Auto-save one shared zone without keeping a device-specific room setting
export function RoomTimeZone({
  room,
  onSaved,
  onDenied,
  onNotice,
}: {
  // Last confirmed room data
  room: Room;
  // Apply the shared zone after a confirmed save
  onSaved: (value: Room) => void;
  // Leave settings after access is lost
  onDenied: () => void;
  // Show a short save result
  onNotice: (value: string) => void;
}) {
  const {t} = useI18n();
  const [busy, setBusy] = useState(false);
  const local = localTimeZone();
  const zone = room.timeZone ?? local;
  const zones = [
    ...new Set([zone, local, 'UTC', ...Intl.supportedValuesOf('timeZone')]),
  ];
  // Retry a stale room version without changing its newer name
  async function save(timeZone: string) {
    if (busy || timeZone === zone) return;
    setBusy(true);
    onNotice('');
    try {
      let revision = room.revision;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`/api/rooms/${room.id}/time-zone`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({timeZone, revision}),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (response.status === 409 && attempt === 0) {
          const current = await fetch(`/api/rooms/${room.id}`, {
            cache: 'no-store',
          });
          const body = await current.json();
          if (!current.ok || !isRoom(body.room)) throw new Error();
          revision = body.room.revision;
          continue;
        }
        const body = await response.json();
        if (!response.ok || !isRoom(body.room)) throw new Error();
        onSaved(body.room);
        onNotice(t('Часовой пояс сохранен'));
        return;
      }
    } catch {
      onNotice(t('Не удалось сохранить часовой пояс'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SelectField
      id="room-time-zone"
      label={t('Часовой пояс комнаты')}
      hint={t('Один часовой пояс для администратора и респондентов')}
      value={zone}
      disabled={busy}
      onChange={(event) => void save(event.target.value)}
    >
      {zones.map((item) => (
        <option key={item} value={item}>
          {item === local
            ? t('Местный ({value0})', {
                value0: item,
              })
            : item}
        </option>
      ))}
    </SelectField>
  );
}
