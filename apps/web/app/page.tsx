'use client';

import {useEffect, useState} from 'react';
import {isHello, type Hello} from '../lib/hello';

type Connection =
  | {status: 'loading'}
  | {status: 'ready'; hello: Hello}
  | {status: 'error'};

export default function Home() {
  const [attempt, setAttempt] = useState(0);
  const [connection, setConnection] = useState<Connection>({status: 'loading'});

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch('/api/hello', {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(8000),
          ]),
        });
        if (!response.ok) throw new Error('Request failed');
        const hello: unknown = await response.json();
        if (!isHello(hello)) throw new Error('Invalid response');
        if (!controller.signal.aborted) setConnection({status: 'ready', hello});
      } catch {
        if (!controller.signal.aborted) setConnection({status: 'error'});
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-5xl flex-col bg-page px-5 py-8 text-ink sm:px-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">
        Vote Machine
      </h1>
      <section className="w-full max-w-2xl" aria-label="Проверка соединения">
        <div
          className="mb-4 min-h-45 rounded-2xl border border-border bg-white p-5 sm:p-7"
          role="status"
          aria-live="polite"
        >
          {connection.status === 'loading' && (
            <p className="leading-relaxed">Проверяем соединение…</p>
          )}
          {connection.status === 'ready' && (
            <>
              <span className="inline-flex rounded-md bg-success-bg px-2.5 py-1.5 text-xs font-medium text-success-ink">
                Соединение работает
              </span>
              <h2 className="mt-5 mb-2 text-2xl font-semibold tracking-tight">
                {connection.hello.message}
              </h2>
              <p className="leading-relaxed text-ink/80">
                Сервис доступен и база данных отвечает
              </p>
            </>
          )}
          {connection.status === 'error' && (
            <>
              <span className="inline-flex rounded-md bg-error-bg px-2.5 py-1.5 text-xs font-medium text-error-ink">
                Нет соединения
              </span>
              <h2 className="mt-5 mb-2 text-2xl font-semibold tracking-tight">
                Не удалось получить ответ
              </h2>
            </>
          )}
        </div>
        <button
          type="button"
          className="rounded-xl bg-ink px-6 py-4 font-medium text-white transition-colors hover:bg-ink/90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-700 disabled:cursor-wait disabled:opacity-60"
          disabled={connection.status === 'loading'}
          onClick={() => {
            setConnection({status: 'loading'});
            setAttempt((value) => value + 1);
          }}
        >
          Проверить снова
        </button>
      </section>
    </main>
  );
}
