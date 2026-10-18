'use client';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ListChecks, History, RefreshCw} from 'lucide-react';
import {Panel} from '../../../components/ui/panel';
import {Button} from '../../../components/ui/button';
import {EmptyState} from '../../../components/ui/empty-state';
import {Tabs} from '../../../components/ui/tabs';
import {Pagination} from '../../../components/ui/pagination';
import {isJourney, type Journey} from '../../../lib/journey';
import {markdownSummary} from '../../../lib/markdown';
import {AnswerForm} from './answer-form';

// Poll snapshots until realtime delivery is added in its own stage
export function ParticipantJourney({
  linkId,
  onDenied,
}: {
  // Participant link with its own scoped cookie
  linkId: string;
  // Remove private content when the session is revoked
  onDenied: () => void;
}) {
  const [snapshot, setSnapshot] = useState<Journey | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [skip, setSkip] = useState<string | null>(null);
  const [section, setSection] = useState('open');
  const [cursors, setCursors] = useState(['0']);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const previous = useRef<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  const refresh = useCallback((message: string) => {
    previous.current = null;
    setNotice(message);
    setAttempt((value) => value + 1);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Never overlap reads or clear a form during a pending write
    async function load() {
      if (busy) return;
      try {
        const query = new URLSearchParams({after: cursor});
        if (selected) query.set('selected', selected);
        if (skip) query.set('skip', skip);
        const response = await fetch(`/api/vote/${linkId}/questions?${query}`, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (response.status === 409 && skip) {
          setSkip(null);
          return;
        }
        const body: unknown = await response.json();
        if (!response.ok || !isJourney(body)) throw new Error();
        if (controller.signal.aborted) return;
        if (
          previous.current &&
          previous.current !== body.current?.id &&
          !body.questions.some(
            (item) => item.id === previous.current && item.answered,
          )
        ) {
          setNotice(
            'Вопрос закрыт или изменен, показан следующий доступный вопрос',
          );
        }
        previous.current = body.current?.id ?? null;
        setSnapshot(body);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 2000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [linkId, selected, skip, cursor, attempt, onDenied, busy]);
  // Preserve the active content while metadata pages change
  function choose(id: string) {
    setSelected(id);
    setSkip(null);
    setNotice('');
  }
  const current = snapshot?.current;
  return (
    <div className="mt-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {snapshot
            ? `Ответов на открытые вопросы: ${snapshot.progress.answered} из ${snapshot.progress.total}`
            : 'Загружаем вопросы…'}
        </p>
        <Button
          variant="ghost"
          startIcon={<RefreshCw />}
          disabled={busy}
          onClick={() => refresh('')}
        >
          Обновить
        </Button>
      </div>
      {notice && (
        <p role="status" className="text-sm text-muted">
          {notice}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-error-ink">
          Не удалось обновить вопросы, пробуем снова
        </p>
      )}
      {snapshot && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
          <Panel aria-label="Текущий вопрос">
            {current ? (
              <AnswerForm
                key={`${current.id}/${current.revision}/${snapshot.answer?.revision ?? 'new'}`}
                timeZone={snapshot.timeZone}
                linkId={linkId}
                question={current}
                answer={snapshot.answer}
                onDenied={onDenied}
                onBusy={setBusy}
                onRefresh={refresh}
                onSaved={() => {
                  previous.current = null;
                  setSelected(null);
                  setSkip(null);
                  refresh('Ответ принят');
                }}
                onSkip={() => {
                  previous.current = null;
                  setSelected(null);
                  setSkip(current.id);
                  setNotice(
                    'Вопрос пропущен, к нему можно вернуться из списка',
                  );
                }}
              />
            ) : (
              <>
                <EmptyState
                  icon={<ListChecks />}
                  title="Ожидание вопросов"
                  description={
                    snapshot.progress.pending
                      ? 'Можно вернуться к неотвеченным вопросам из списка'
                      : 'Здесь появятся новые вопросы комнаты'
                  }
                />
                {skip && (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSkip(null);
                      setSelected(null);
                    }}
                  >
                    Вернуться к вопросам
                  </Button>
                )}
              </>
            )}
          </Panel>
          <Panel>
            <Tabs
              label="Вопросы участника"
              value={section}
              onChange={setSection}
              items={[
                {id: 'open', label: 'Вопросы', icon: <ListChecks />},
                {id: 'history', label: 'Мои ответы', icon: <History />},
              ]}
            />
            <ul className="mt-4 divide-y divide-border">
              {snapshot.questions
                .filter((item) =>
                  section === 'history' ? item.answered : item.state === 'open',
                )
                .map((item) => (
                  <li key={item.id} className="py-3">
                    <Button
                      variant="ghost"
                      className="h-auto w-full justify-start text-left whitespace-normal"
                      disabled={busy || !item.canChoose}
                      aria-current={
                        current?.id === item.id ? 'true' : undefined
                      }
                      onClick={() => choose(item.id)}
                    >
                      {markdownSummary(item.preview) || 'Вопрос'}
                    </Button>
                    <p className="mt-1 text-xs text-muted">
                      {item.answered
                        ? 'Ответ сохранен'
                        : item.canChoose
                          ? 'Без ответа'
                          : 'Сначала ответьте на обязательный вопрос'}
                      {item.state === 'closed' ? ' · Закрыт' : ''}
                    </p>
                  </li>
                ))}
            </ul>
            <Pagination
              label="Страницы вопросов участника"
              page={cursors.length}
              hasNext={Boolean(snapshot.nextCursor)}
              busy={busy}
              onPrevious={() => setCursors((value) => value.slice(0, -1))}
              onNext={() =>
                snapshot.nextCursor &&
                setCursors((value) => [...value, snapshot.nextCursor!])
              }
            />
          </Panel>
        </div>
      )}
    </div>
  );
}
