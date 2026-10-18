'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import Link from 'next/link';
import {Brand} from '../../../components/brand';
import {Panel} from '../../../components/ui/panel';
import {Button} from '../../../components/ui/button';
import {ParticipantJourney} from './journey';
import {roomIdPattern, secretPattern} from '../../../lib/rooms';
import {isParticipant, type Participant} from '../../../lib/voting-links';

// Check a participant link and keep its role separate from admin access
export default function VotingEntry({id}: {id: string}) {
  // Current access state
  const [state, setState] = useState<'loading' | 'ready' | 'denied' | 'error'>(
    'loading',
  );
  // Leave private content when a later access check fails
  const denyAccess = useCallback(() => setState('denied'), []);
  // Labels from the allowed link
  const [participant, setParticipant] = useState<Participant | null>(null);
  // Retry counter
  const [attempt, setAttempt] = useState(0);
  // Key kept only until session exchange succeeds
  const key = useRef<string | null>(null);
  // Read each URL key only once
  const captured = useRef(false);
  useEffect(() => {
    // A replacement key may open in the same tab
    function newLink() {
      if (window.location.hash) {
        captured.current = false;
        key.current = null;
        setAttempt((value) => value + 1);
      }
    }
    window.addEventListener('hashchange', newLink);
    return () => window.removeEventListener('hashchange', newLink);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    // Clear the URL before sending its secret to the server
    async function load() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      if (!captured.current) {
        captured.current = true;
        const fragment = window.location.hash.slice(1);
        window.history.replaceState(null, '', window.location.pathname);
        const token = new URLSearchParams(fragment).get('key');
        if (token !== null && !secretPattern.test(token)) {
          setState('denied');
          return;
        }
        key.current = token;
      }
      if (!roomIdPattern.test(id)) {
        setState('denied');
        return;
      }
      setState('loading');
      try {
        const token = key.current;
        const response = await fetch(
          `/api/vote/${id}${token ? '/session' : ''}`,
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
        // Recheck access after revoke or key changes
        if (response.status === 401) {
          setState('denied');
          return;
        }
        if (!response.ok) throw new Error('Access failed');
        const data = await response.json();
        if (!isParticipant(data.participant) || data.participant.linkId !== id)
          throw new Error('Invalid participant');
        if (!controller.signal.aborted) {
          key.current = null;
          setParticipant(data.participant);
          setState('ready');
        }
      } catch {
        if (!controller.signal.aborted) setState('error');
      }
    }
    void load();
    return () => controller.abort();
  }, [id, attempt]);
  return (
    <main className="min-h-svh bg-page px-4 py-6 text-ink">
      <div className="mx-auto max-w-5xl">
        <Link href="/" aria-label="На главную">
          <Brand />
        </Link>
        {state === 'loading' && (
          <p role="status" className="mt-8">
            Проверяем ссылку…
          </p>
        )}
        {state === 'denied' && (
          <Panel className="mt-8">
            <h1 className="text-2xl font-semibold">Ссылка недействительна</h1>
            <p className="mt-4 text-sm text-muted">
              Запросите действующую ссылку у администратора
            </p>
          </Panel>
        )}
        {state === 'error' && (
          <Panel className="mt-8">
            <h1 className="text-2xl font-semibold">
              Не удалось открыть комнату
            </h1>
            <Button
              className="mt-5"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Попробовать снова
            </Button>
          </Panel>
        )}
        {state === 'ready' && participant && (
          <>
            <h1 className="mt-8 text-2xl font-semibold">
              {participant.roomName}
            </h1>
            <p className="mt-3 text-sm text-muted">
              {participant.name} ·{' '}
              {participant.mode === 'personal'
                ? 'Персональная ссылка'
                : 'Многоразовая ссылка'}
            </p>
            <ParticipantJourney linkId={id} onDenied={denyAccess} />
          </>
        )}
      </div>
    </main>
  );
}
