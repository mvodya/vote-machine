'use client';
import {useEffect, useState, useSyncExternalStore} from 'react';
import {usePathname} from 'next/navigation';
import {
  Activity,
  Clock,
  Fingerprint,
  Gauge,
  History,
  Radio,
  RefreshCw,
  Server,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  connectionSnapshot,
  serverConnectionSnapshot,
  subscribeConnection,
} from '../lib/connection-state';
import {Popover} from './ui/popover';

interface Probe {
  // Safe API labels and the local time when the reply arrived
  apiId: string;
  commit: string;
  serverTime: number;
  received: number;
  clientId: string | null;
  ping: number;
}
// Inspect the existing SSE streams and a small end-to-end health probe
export function ConnectionIndicator() {
  const pathname = usePathname();
  const streams = useSyncExternalStore(
    subscribeConnection,
    connectionSnapshot,
    serverConnectionSnapshot,
  );
  const [probe, setProbe] = useState<Probe | null>(null);
  const [samples, setSamples] = useState<(number | null)[]>([]);
  const [client, setClient] = useState('');
  const [clock, setClock] = useState(0);
  const [mediaFailure, setMediaFailure] = useState<{
    status: number;
    code?: number;
    at: number;
    count: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const [scope, id] = pathname.split('/').filter(Boolean);
    const query = new URLSearchParams({scope: scope ?? '', id: id ?? ''});
    // Poll only while visible, every probe has its own bounded wait
    async function check() {
      if (document.hidden || controller.signal.aborted) return;
      const started = performance.now();
      try {
        const response = await fetch(`/api/connection?${query}`, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(6000),
          ]),
        });
        const data = await response.json();
        if (
          !response.ok ||
          typeof data.apiId !== 'string' ||
          !Number.isSafeInteger(data.serverTime)
        )
          throw new Error('Unavailable');
        if (active) {
          const ping = Math.round(performance.now() - started);
          setProbe({...data, ping, received: Date.now()});
          setSamples((old) => [...old.slice(-19), ping]);
        }
      } catch {
        if (active) setSamples((old) => [...old.slice(-19), null]);
      }
    }
    // This fallback identifies the tab and is never an authentication key
    queueMicrotask(() => {
      if (!active) return;
      try {
        const key = 'vm-debug-client';
        const value = sessionStorage.getItem(key) || crypto.randomUUID();
        sessionStorage.setItem(key, value);
        setClient(value);
      } catch {
        setClient(crypto.randomUUID());
      }
    });
    // Media failures keep only codes, never URLs or room content
    function media(event: Event) {
      const data = (
        event as CustomEvent<{status: number; code?: number; at: number}>
      ).detail;
      if (Number.isInteger(data?.status) && Number.isFinite(data?.at))
        setMediaFailure((old) => ({...data, count: (old?.count ?? 0) + 1}));
    }
    function offline() {
      setSamples((old) => [...old.slice(-19), null]);
    }
    window.addEventListener('vm-media-failure', media);
    window.addEventListener('offline', offline);
    void check();
    const poll = setInterval(() => void check(), 15000);
    const tick = setInterval(() => setClock(Date.now()), 1000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      active = false;
      window.removeEventListener('vm-media-failure', media);
      window.removeEventListener('offline', offline);
      controller.abort();
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, [pathname]);
  const last = samples.at(-1);
  const good = samples.filter((value): value is number => value !== null);
  const spread = good.length ? Math.max(...good) - Math.min(...good) : 0;
  const lost = streams.some(
    (stream) => stream.status === 'disconnected' || stream.status === 'denied',
  );
  const stale = streams.some(
    (stream) => !stream.lastEvent || clock - stream.lastEvent > 35000,
  );
  const status =
    last === null || lost
      ? 'Нет связи'
      : last === undefined || stale || last > 800 || spread > 500
        ? 'Нестабильное'
        : 'Стабильное';
  const colors =
    status === 'Нет связи'
      ? 'from-red-300 to-red-600 shadow-red-500/50'
      : status === 'Нестабильное'
        ? 'from-yellow-200 to-amber-500 shadow-amber-400/50'
        : 'from-emerald-200 to-emerald-600 shadow-emerald-500/50';
  return (
    <Popover
      label="Подключение"
      className="size-10"
      trigger={
        <span
          aria-hidden="true"
          className={`size-3 rounded-full bg-gradient-to-br shadow-[0_0_10px_3px] ${colors}`}
        />
      }
    >
      <h2 className="mb-3 text-sm font-semibold">Подключение</h2>
      <dl className="space-y-3 break-words">
        <Detail icon={Activity} label="Состояние">
          {status}
        </Detail>
        <Detail icon={Gauge} label="Задержка">
          {probe ? `${probe.ping} мс` : 'Проверяем…'}
        </Detail>
        <div>
          <dt className="mb-2 flex items-center gap-2 text-muted">
            <History aria-hidden="true" className="size-4 shrink-0" />
            Последние задержки
          </dt>
          <dd>
            <div
              role="img"
              aria-label={`Последние задержки: ${samples.map((value) => (value === null ? 'нет связи' : `${value} мс`)).join(', ') || 'проверяем'}`}
              className="flex h-20 items-end gap-1 rounded-lg border border-border bg-page/50 p-2"
            >
              {Array.from({length: 20}, (_, index) => {
                const value = samples[index];
                return (
                  <span
                    key={index}
                    title={
                      value === undefined
                        ? 'Нет данных'
                        : value === null
                          ? 'Нет связи'
                          : `${value} мс`
                    }
                    className={`min-w-0 flex-1 rounded-t-sm ${value === null ? 'bg-error-ink' : value === undefined ? 'bg-border/40' : 'bg-primary/70'}`}
                    style={{
                      height:
                        value == null
                          ? '4px'
                          : `${Math.max(6, (value / Math.max(100, ...good)) * 100)}%`,
                    }}
                  />
                );
              })}
            </div>
          </dd>
        </div>
        <Detail icon={Activity} label="Разброс задержки">
          {spread} мс
        </Detail>
        <Detail icon={Clock} label="Время сервера, UTC">
          {probe
            ? new Date(
                probe.serverTime + Math.max(0, clock - probe.received),
              ).toISOString()
            : 'Нет данных'}
        </Detail>
        <Detail icon={Fingerprint} label="ID сессии">
          <span className="font-mono">
            {probe?.clientId || client || 'Проверяем…'}
          </span>
        </Detail>
        {mediaFailure && (
          <Detail icon={TriangleAlert} label="Последняя ошибка медиа / всего">
            HTTP {mediaFailure.status || 'Нет ответа'}
            {mediaFailure.code ? `, плеер ${mediaFailure.code}` : ''} /{' '}
            {mediaFailure.count}
            <br />
            {new Date(mediaFailure.at).toLocaleTimeString('ru-RU')}
          </Detail>
        )}
        {streams.map((stream, index) => (
          <div key={index} className="space-y-2 border-t border-border pt-3">
            <Detail icon={Radio} label={`Поток ${index + 1}`}>
              {stream.status === 'connected'
                ? 'Подключен'
                : stream.status === 'connecting'
                  ? 'Подключаем…'
                  : 'Отключен'}
            </Detail>
            <Detail icon={Server} label="API / коммит">
              <span className="font-mono">
                {stream.apiId || 'API не определен'} /{' '}
                {stream.commit || 'Нет коммита'}
              </span>
            </Detail>
            <Detail icon={RefreshCw} label="Переподключений">
              {stream.reconnects}
            </Detail>
            <Detail icon={Clock} label="Последнее событие">
              {stream.lastEvent
                ? `${Math.max(0, Math.round((clock - stream.lastEvent) / 1000))} с назад`
                : 'Ожидаем'}
            </Detail>
          </div>
        ))}
      </dl>
    </Popover>
  );
}

// Align small labels and keep their icons the same size
function Detail({
  icon: Icon,
  label,
  children,
}: {
  // Icon and name for one connection value
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-2 text-muted">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </dt>
      <dd className="pl-6">{children}</dd>
    </div>
  );
}
