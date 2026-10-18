'use client';

import {RoomName} from './room-name';
import {Questions} from './questions';
import {QuestionPolicy} from './question-policy';
import {Respondents} from './respondents';

import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {ListChecks, Users, ChartColumn, Settings, Copy} from 'lucide-react';
import {Brand} from '../../../components/brand';
import {Tabs} from '../../../components/ui/tabs';
import {EmptyState} from '../../../components/ui/empty-state';
import {Button} from '../../../components/ui/button';
import {TextField} from '../../../components/ui/text-field';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {
  isRoom,
  roomIdPattern,
  secretPattern,
  type Room,
} from '../../../lib/rooms';

type State = 'loading' | 'ready' | 'denied' | 'error';

// Show the room and its admin tools
export default function AdminRoom({id}: {id: string}) {
  // Loading and access state of the page
  const [state, setState] = useState<State>('loading');
  // Room data returned by the API
  const [room, setRoom] = useState<Room | null>(null);
  // Full admin link shown in settings
  const [link, setLink] = useState('');
  // Change this value to retry loading
  const [attempt, setAttempt] = useState(0);
  // Short result or error message
  const [notice, setNotice] = useState('');
  // Current room tab
  const [section, setSection] = useState('questions');
  // Link key kept until the session is opened
  const key = useRef<string | null>(null);
  // Whether this URL has already been read
  const captured = useRef(false);

  // Leave private panels when the session is rejected
  const denyAccess = useCallback(() => setState('denied'), []);

  useEffect(() => {
    // Handle a new link opened on the same page
    function openLink() {
      // A plain URL has no new key to read
      if (!window.location.hash) return;
      captured.current = false;
      key.current = null;
      setLink('');
      setState('loading');
      setAttempt((value) => value + 1);
    }
    window.addEventListener('hashchange', openLink);
    return () => window.removeEventListener('hashchange', openLink);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Open a session or read the room with a saved one
    async function load() {
      // Let a closed page stop this load first
      await Promise.resolve();
      if (controller.signal.aborted) return;
      // Read and clear the URL key only once
      if (!captured.current) {
        captured.current = true;
        const fragment = window.location.hash.slice(1);
        window.history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search,
        );
        const token = new URLSearchParams(fragment).get('admin');
        // A link key must be checked before it is sent
        if (token !== null) {
          if (!secretPattern.test(token)) {
            setState('denied');
            return;
          }
          key.current = token;
        }
      }
      // A bad room ID cannot grant access
      if (!roomIdPattern.test(id)) {
        setState('denied');
        return;
      }
      setState('loading');
      try {
        const token = key.current;
        const response = await fetch(
          `/api/rooms/${id}${token ? '/session' : ''}`,
          {
            method: token ? 'POST' : 'GET',
            cache: 'no-store',
            headers: token ? {'Content-Type': 'application/json'} : undefined,
            body: token ? JSON.stringify({token}) : undefined,
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          },
        );
        if (controller.signal.aborted) return;
        // A rejected session needs an admin link
        if (response.status === 401) {
          setState('denied');
          return;
        }
        if (!response.ok) throw new Error('Load failed');
        const body = await response.json();
        if (!isRoom(body.room) || body.room.id !== id)
          throw new Error('Invalid room');
        if (!controller.signal.aborted) {
          key.current = null;
          setRoom(body.room);
          setState('ready');
        }
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [id, attempt]);

  useEffect(() => {
    // Read private link data only in open settings
    if (state !== 'ready' || section !== 'settings') return;
    const controller = new AbortController();
    // Read the saved link through the current session
    async function loadLink() {
      try {
        const response = await fetch(`/api/rooms/${id}/admin-link`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Link unavailable');
        const body = await response.json();
        if (!secretPattern.test(body.adminToken ?? ''))
          throw new Error('Invalid link');
        if (!controller.signal.aborted)
          setLink(
            `${window.location.origin}/rooms/${id}#admin=${body.adminToken}`,
          );
      } catch {
        if (!controller.signal.aborted)
          setNotice('Не удалось получить административную ссылку');
      }
    }
    void loadLink();
    return () => controller.abort();
  }, [id, section, state, attempt]);

  // Copy the full admin link or suggest manual copying
  async function copy() {
    try {
      // The browser may deny clipboard access
      await navigator.clipboard.writeText(link);
      setNotice('Ссылка скопирована');
    } catch {
      setNotice('Выделите ссылку и скопируйте ее вручную');
    }
  }

  return (
    <main className="min-h-svh bg-page text-ink">
      <div className="mx-auto max-w-6xl px-4 pb-10 sm:px-8">
        <header className="flex items-center justify-between border-b border-border py-5 sm:py-6">
          <Link
            className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
            href="/"
            aria-label="На главную"
          >
            <Brand />
          </Link>
        </header>
        {state === 'loading' && (
          <p role="status" className="mt-8">
            Открываем комнату…
          </p>
        )}
        {state === 'denied' && (
          <Panel className="mt-8">
            <h1 className="text-2xl font-semibold">Нет доступа к комнате</h1>
            <p className="mt-4">
              Откройте полную административную ссылку, которую вы сохранили при
              создании комнаты
            </p>
            <p className="mt-3">
              Без ссылки и действующей сессии восстановить управление невозможно
            </p>
          </Panel>
        )}
        {state === 'error' && (
          <Panel className="mt-8">
            <h1 className="text-2xl font-semibold">
              Не удалось открыть комнату
            </h1>
            <Button
              className="mt-4"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Попробовать снова
            </Button>
          </Panel>
        )}
        {state === 'ready' && room && (
          <>
            <h1 className="mt-8 mb-6 text-2xl font-semibold tracking-tight break-words sm:text-3xl">
              {room.name}
            </h1>
            <Tabs
              label="Разделы комнаты"
              value={section}
              onChange={(value) => {
                setSection(value);
                setNotice('');
              }}
              items={[
                {
                  id: 'questions',
                  label: 'Вопросы',
                  icon: <ListChecks size={18} />,
                },
                {
                  id: 'respondents',
                  label: 'Респонденты',
                  icon: <Users size={18} />,
                },
                {
                  id: 'results',
                  label: 'Результаты',
                  icon: <ChartColumn size={18} />,
                },
                {
                  id: 'settings',
                  label: 'Настройки',
                  icon: <Settings size={18} />,
                },
              ]}
            />
            <section
              role="tabpanel"
              aria-label={
                section === 'questions'
                  ? 'Вопросы'
                  : section === 'respondents'
                    ? 'Респонденты'
                    : section === 'results'
                      ? 'Результаты'
                      : 'Настройки'
              }
              className="pt-6"
            >
              {section === 'questions' && (
                <Questions roomId={id} onDenied={denyAccess} />
              )}
              {section === 'respondents' && (
                <Respondents roomId={id} onDenied={denyAccess} />
              )}
              {section === 'results' && (
                <Panel>
                  <SectionHeader title="Результаты"></SectionHeader>
                  <EmptyState
                    icon={<ChartColumn size={32} />}
                    title="Результатов пока нет"
                    description="Здесь появятся результаты голосования"
                  />
                </Panel>
              )}
              {section === 'settings' && (
                <div className="grid items-start gap-6 lg:grid-cols-[1fr_1.2fr]">
                  <div className="space-y-6">
                    <Panel aria-label="Настройки комнаты">
                      <h2 className="mb-5 text-lg font-semibold">Комната</h2>
                      <RoomName
                        room={room}
                        onSaved={setRoom}
                        onDenied={denyAccess}
                        onNotice={setNotice}
                      />
                    </Panel>
                    <QuestionPolicy roomId={id} onDenied={denyAccess} />
                  </div>
                  <Panel aria-label="Административный доступ">
                    <h2 className="mb-3 text-lg font-semibold">
                      Административный доступ
                    </h2>
                    <p className="mb-5 text-sm">
                      Ссылка дает полный доступ к управлению комнатой
                    </p>
                    {link ? (
                      <>
                        <TextField
                          id="admin-link"
                          label="Административная ссылка"
                          className="font-mono"
                          readOnly
                          value={link}
                          onFocus={(event) => event.target.select()}
                        />
                        <Button
                          onClick={() => void copy()}
                          variant="secondary"
                          className="mt-4"
                          startIcon={<Copy />}
                        >
                          Скопировать ссылку
                        </Button>
                      </>
                    ) : (
                      <Button onClick={() => setAttempt((value) => value + 1)}>
                        Получить ссылку
                      </Button>
                    )}
                  </Panel>
                </div>
              )}
            </section>
            <p role="status" className="mt-4 text-sm text-muted">
              {notice}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
