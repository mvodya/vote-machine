'use client';
import {useI18n} from '../components/language-provider';
import {useEffect, useState, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import CreateRoom from './create-room';
import {roomDestination} from '../lib/rooms';
import Link from 'next/link';
import {ArrowUpRight, Trash2, Plus, LogIn} from 'lucide-react';
import {SegmentedControl} from '../components/ui/segmented-control';
import motion from '../components/ui/motion.module.css';
import {Button} from '../components/ui/button';
import {TextField} from '../components/ui/text-field';
import {Form} from '../components/ui/form';
// Show recent rooms or the link entry form
export default function RoomEntry() {
  const {t} = useI18n();
  const router = useRouter();
  // Create mode or room entry mode
  const [mode, setMode] = useState<'create' | 'join'>('create');
  // Link typed by the user
  const [link, setLink] = useState('');
  // Whether the typed link is invalid
  const [invalid, setInvalid] = useState(false);
  // Cached names from saved browser entries
  const [rooms, setRooms] = useState<
    {
      id: string;
      name: string;
    }[]
  >([]);
  // Show link entry instead of saved rooms
  const [byLink, setByLink] = useState(false);
  // Error while reading or removing an entry
  const [listError, setListError] = useState(false);
  // Load saved names only when room entry is opened
  useEffect(() => {
    // Creating a room does not need the saved list
    if (mode !== 'join') return;
    const controller = new AbortController();
    // Read cached names without asking the database
    async function load() {
      try {
        const response = await fetch('/api/recent-rooms', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Recent rooms failed');
        const data = await response.json();
        // Do not change state after leaving this view
        if (!controller.signal.aborted)
          setRooms(Array.isArray(data.rooms) ? data.rooms : []);
      } catch {
        // Do not change state after leaving this view
        if (!controller.signal.aborted) setListError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [mode]);
  // Remove a browser entry without deleting its room
  async function remove(id: string) {
    try {
      const response = await fetch(`/api/recent-rooms/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Remove failed');
      setRooms((current) => current.filter((room) => room.id !== id));
    } catch {
      setListError(true);
    }
  }
  // Open a checked link, including non-admin links
  function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = roomDestination(link, window.location.origin);
    // Keep invalid or external links on this page
    if (!destination) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    router.push(destination);
  }
  return (
    <div className="mx-auto my-auto w-full max-w-105 py-12 lg:py-8">
      <SegmentedControl
        label={t('Действие с комнатой')}
        value={mode}
        className="rounded-2xl border border-border/70 p-1.5"
        items={[
          {
            id: 'create',
            label: t('Создать'),
            icon: <Plus />,
          },
          {
            id: 'join',
            label: t('Войти'),
            icon: <LogIn />,
          },
        ]}
        onChange={(next) => {
          setMode(next as 'create' | 'join');
          if (next === 'create') setInvalid(false);
        }}
      />
      <div key={mode} className={`${motion.content} pt-8`}>
        <h1 className="text-3xl font-semibold tracking-tight">
          {mode === 'create' ? t('Новая комната') : t('Вход в комнату')}
        </h1>
        <p className="mt-3 mb-7 text-sm leading-6 text-muted">
          {mode === 'create'
            ? t('Создайте комнату для голосования')
            : rooms.length && !byLink
              ? t('Последние комнаты')
              : t('Вставьте ссылку на комнату')}
        </p>
        {mode === 'create' ? (
          <CreateRoom />
        ) : rooms.length > 0 && !byLink ? (
          <div className="recent-rooms">
            <ul className="space-y-2">
              {rooms.map((room) => (
                <li
                  key={room.id}
                  className="flex min-w-0 items-center gap-1 rounded-xl border border-border bg-panel p-1 transition-colors hover:border-ink/25"
                >
                  <Link
                    className="min-w-0 flex-1 truncate rounded-lg px-3 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ink"
                    href={`/rooms/${room.id}`}
                    prefetch={false}
                    title={room.name}
                  >
                    {room.name}
                  </Link>
                  <Button
                    variant="ghost"
                    aria-label={t('Убрать комнату {value0} из списка', {
                      value0: room.name,
                    })}
                    onClick={() => void remove(room.id)}
                  >
                    <Trash2 size={18} />
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              className="mt-3 w-full text-xs underline underline-offset-4"
              onClick={() => setByLink(true)}
            >
              {t('Войти по ссылке')}
            </Button>
          </div>
        ) : (
          <Form onSubmit={join}>
            <TextField
              id="room-link"
              label={t('Ссылка на комнату')}
              value={link}
              required
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              inputMode="url"
              placeholder={t('Вставьте ссылку сюда')}
              error={
                invalid
                  ? t('Вставьте корректную ссылку на комнату с этого сайта')
                  : undefined
              }
              onChange={(event) => {
                setLink(event.target.value);
                setInvalid(false);
              }}
            />
            <Button
              type="submit"
              fullWidth
              endIcon={<ArrowUpRight size={20} />}
            >
              {t('Войти в комнату')}
            </Button>
            {rooms.length > 0 && (
              <Button
                variant="ghost"
                className="mt-3 w-full text-xs underline underline-offset-4"
                onClick={() => setByLink(false)}
              >
                {t('Показать список ранее использованных комнат')}
              </Button>
            )}
          </Form>
        )}
        {listError && (
          <p role="alert" className="mt-4 text-sm text-error-ink">
            {t('Не удалось обновить список комнат')}
          </p>
        )}
      </div>
      <p className="mt-7 text-center text-xs leading-5 text-muted">
        {t('Сохраните ссылку, чтобы вернуться в комнату')}
      </p>
    </div>
  );
}
