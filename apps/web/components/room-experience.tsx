'use client';
import {Spinner} from './ui/loading';
import {useEffect, useRef, useState, type ReactNode} from 'react';
import {useDeadlineSounds} from '../lib/use-deadline-sounds';
import {useLive} from '../lib/use-live';
import {isAccent} from '../lib/experience';
import {playSound, type Sound} from '../lib/audio';
// Wait for the shared palette before showing private room content
export function RoomExperience({
  id,
  admin,
  active,
  onDenied,
  children,
}: {
  id: string;
  admin: boolean;
  active: boolean;
  onDenied: () => void;
  children: ReactNode;
}) {
  // Keep private content hidden until its palette is ready
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // Only nearby deadlines are needed for room alarms
  const [timers, setTimers] = useState<string[]>([]);
  useDeadlineSounds(active ? timers : []);
  // Public event cursors never count hidden answers
  const cursor = useRef<string | null>(null);
  const live = useLive(
    active ? `/api/${admin ? 'rooms' : 'vote'}/${id}/events` : null,
    onDenied,
  );
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Keep the baseline across live refreshes and reconnects
    async function load() {
      try {
        const response = await fetch(
          `/api/${admin ? 'rooms' : 'vote'}/${id}/experience${cursor.current === null ? '' : `?after=${cursor.current}`}`,
          {cache: 'no-store', signal: controller.signal},
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (
          !response.ok ||
          !isAccent(data.accent) ||
          !Array.isArray(data.events) ||
          typeof data.cursor !== 'string'
        )
          throw new Error();
        if (controller.signal.aborted) return;
        document.documentElement.dataset.accent = data.accent;
        // The first snapshot must stay silent
        if (cursor.current !== null)
          for (const event of data.events)
            playSound(
              event.kind as Sound,
              `${admin ? 'admin' : 'vote'}:${id}:${event.id}`,
            );
        setTimers(data.timers);
        setFailed(false);
        cursor.current = data.cursor;
        setReady(true);
        timer = setTimeout(
          () => void load(),
          data.events.length === 100 ? 0 : live.connected ? 30000 : 2000,
        );
      } catch {
        if (!controller.signal.aborted) setFailed(true);
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 2000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, admin, active, onDenied, live.version, live.connected]);
  useEffect(
    () => () => {
      delete document.documentElement.dataset.accent;
    },
    [],
  );
  if (active && !ready)
    return (
      <div className="p-8 text-muted">
        <Spinner
          label={
            failed
              ? 'Не удалось загрузить настройки комнаты, повторяем'
              : 'Открываем комнату…'
          }
        />
      </div>
    );
  return children;
}
