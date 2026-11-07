'use client';
import {useI18n} from '../../../components/language-provider';
import {Loading} from '../../../components/ui/loading';
import {useCallback, useEffect, useRef, useState} from 'react';
import {ListChecks, Check, X, Repeat2} from 'lucide-react';
import {Panel} from '../../../components/ui/panel';
import {Button} from '../../../components/ui/button';
import {EmptyState} from '../../../components/ui/empty-state';
import {TabPanels} from '../../../components/ui/tab-panels';
import {TabPanel} from '../../../components/ui/tab-panel';
import {ParticipantTabs} from '../../../components/workspace-tabs';
import {Pagination} from '../../../components/ui/pagination';
import {isJourney, type Journey} from '../../../lib/journey';
import {markdownSummary} from '../../../lib/markdown';
import {SelectField} from '../../../components/ui/select-field';
import {useLive} from '../../../lib/use-live';
import {QuestionProgress} from '../../../components/question-progress';
import {Countdown} from '../../../components/countdown';
import {useQuestionPresence} from '../../../lib/use-question-presence';
import {Results} from '../../../components/results';
import {AnswerForm} from './answer-form';
// Keep snapshots fresh while the participant moves between tabs
export function ParticipantJourney({
  linkId,
  onDenied,
}: {
  // Participant link with its own scoped cookie
  linkId: string;
  // Remove private content when the session is revoked
  onDenied: () => void;
}) {
  const {t, localeTag} = useI18n();
  const live = useLive(`/api/vote/${linkId}/events`, onDenied);
  const [runId, setRunId] = useState<string | null>(null);
  const newRun = useRef<string | null>(null);
  const [snapshot, setSnapshot] = useState<Journey | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [skip, setSkip] = useState<string | null>(null);
  const [section, setSection] = useState('question');
  const [review, setReview] = useState(false);
  const [cursors, setCursors] = useState(['0']);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const previous = useRef<string | null>(null);
  // Live snapshots must not steal focus from a person reading or typing
  const moveFocus = useRef(false);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    document.getElementById(`participant-tabs-panel-${section}`)?.focus();
  }, [section, snapshot]);
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
        if (runId) query.set('run', runId);
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
        // A disabled old run must return to the current run without stale answers
        if (response.status === 404 && runId) {
          setRunId(null);
          setSelected(null);
          setReview(false);
          setSnapshot(null);
          setCursors(['0']);
          previous.current = null;
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
        if (body.run?.id && !runId) setRunId(body.run.id);
        if (selected && body.current?.id !== selected) {
          setSelected(null);
          setReview(false);
        }
        if (!body.resultsAvailable)
          setSection((currentSection) =>
            currentSection === 'results' ? 'question' : currentSection,
          );
        setSnapshot(body);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), live.connected ? 30000 : 2000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [
    linkId,
    selected,
    skip,
    cursor,
    attempt,
    onDenied,
    busy,
    runId,
    live.version,
    live.connected,
  ]);
  // Preserve the active content while metadata pages change
  function choose(id: string, answered: boolean) {
    moveFocus.current = true;
    setReview(answered);
    setSection('question');
    setSelected(id);
    setSkip(null);
    setNotice('');
  }
  // A new request ID means an explicit additional ballot run
  async function repeat() {
    if (busy) return;
    setBusy(true);
    try {
      newRun.current ??= crypto.randomUUID();
      const response = await fetch(`/api/vote/${linkId}/runs`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({requestId: newRun.current}),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok || !body.run?.id) throw new Error();
      newRun.current = null;
      moveFocus.current = true;
      setRunId(body.run.id);
      setSelected(null);
      setReview(false);
      setSection('question');
      setSkip(null);
      setCursors(['0']);
      previous.current = null;
      setNotice('');
    } catch {
      setNotice('Не удалось начать повторное голосование');
    } finally {
      setBusy(false);
    }
  }
  const current = snapshot?.current;
  const shown = selected && current?.id !== selected ? null : current;
  useQuestionPresence(
    linkId,
    section === 'question'
      ? (shown?.id ?? snapshot?.upcoming?.id ?? null)
      : null,
    runId,
    onDenied,
  );
  // Review and edit return to the list instead of advancing the queue
  function closeReview() {
    moveFocus.current = true;
    setReview(false);
    setSelected(null);
    setSkip(null);
    setSection('list');
  }
  return (
    <div className="mt-6 space-y-5">
      <ParticipantTabs
        group="participant-tabs"
        value={section}
        onChange={(next) => {
          if (!busy) setSection(next);
        }}
        resultsAvailable={Boolean(snapshot?.resultsAvailable)}
      />
      {notice && (
        <p role="status" className="text-sm text-muted">
          {t(notice)}
        </p>
      )}
      {failed && (
        <p role="alert" className="text-sm text-error-ink">
          {t('Не удалось обновить вопросы, пробуем снова')}
        </p>
      )}
      <TabPanels group="participant-tabs" value={section}>
        <TabPanel group="participant-tabs" id="question" value={section}>
          {section === 'question' && (
            <Panel aria-label={t('Текущий вопрос')}>
              <QuestionProgress
                pending={snapshot?.progress.pending}
                at={
                  shown?.state === 'open'
                    ? shown.closesAt
                    : (shown?.scheduledAt ??
                      (!shown ? snapshot?.upcoming?.scheduledAt : null))
                }
                kind={shown?.state === 'open' ? 'close' : 'start'}
                timeZone={snapshot?.timeZone}
              >
                {review && (
                  <Button
                    variant="secondary"
                    startIcon={<X />}
                    disabled={busy}
                    onClick={closeReview}
                  >
                    {t('Закрыть')}
                  </Button>
                )}
              </QuestionProgress>
              {shown ? (
                <AnswerForm
                  key={`${runId ?? 'personal'}/${shown.id}/${shown.revision}/${shown.questionType === 'allocation' ? 'allocation' : (snapshot?.answer?.revision ?? 'new')}`}
                  timeZone={snapshot?.timeZone}
                  extraPayload={runId ? {runId} : undefined}
                  linkId={linkId}
                  question={shown}
                  answer={snapshot?.answer ?? null}
                  onSelectionStart={() => setSelected(shown.id)}
                  onSelectionSaved={() => {
                    setSelected(shown.id);
                    refresh('');
                  }}
                  onDenied={onDenied}
                  onBusy={setBusy}
                  onRefresh={refresh}
                  onSaved={() => {
                    moveFocus.current = true;
                    previous.current = null;
                    setSelected(null);
                    setSkip(null);
                    if (review) {
                      setReview(false);
                      setSection('list');
                    }
                    refresh(t('Ответ принят'));
                  }}
                  onSkip={() => {
                    moveFocus.current = true;
                    previous.current = null;
                    setSelected(null);
                    setSkip(shown.id);
                    setNotice(
                      'Вопрос пропущен, к нему можно вернуться из списка',
                    );
                  }}
                />
              ) : snapshot && !selected ? (
                <>
                  <EmptyState
                    icon={<ListChecks />}
                    title={
                      snapshot.upcoming
                        ? t('Ожидание открытия вопроса')
                        : snapshot.progress.pending
                          ? t('Остались вопросы без ответа')
                          : snapshot.questions.length || snapshot.progress.total
                            ? t('Все вопросы пройдены')
                            : t('Ожидание вопросов')
                    }
                    description={
                      snapshot.upcoming
                        ? markdownSummary(snapshot.upcoming.preview)
                        : t('Ответы и пропущенные вопросы доступны в списке')
                    }
                  />
                  <Button
                    variant="secondary"
                    startIcon={<ListChecks />}
                    onClick={() => setSection('list')}
                  >
                    {t('К списку вопросов')}
                  </Button>
                  {snapshot.run &&
                    snapshot.repeatAllowed &&
                    !snapshot.progress.pending && (
                      <Button
                        className="ml-3"
                        startIcon={<Repeat2 />}
                        disabled={busy}
                        onClick={() => void repeat()}
                      >
                        {t('Ответить еще раз')}
                      </Button>
                    )}
                </>
              ) : (
                <Loading label={t('Загружаем вопрос…')} rows={2} />
              )}
            </Panel>
          )}
        </TabPanel>
        <TabPanel group="participant-tabs" id="list" value={section}>
          {section === 'list' && (
            <Panel aria-label={t('Список вопросов участника')}>
              {snapshot?.run && (snapshot.runs?.length ?? 0) > 1 && (
                <SelectField
                  id="voting-run"
                  label={t('Прохождение')}
                  value={runId ?? snapshot.run.id}
                  disabled={busy}
                  onChange={(event) => {
                    setRunId(event.target.value);
                    setSelected(null);
                    setReview(false);
                    setSkip(null);
                    setCursors(['0']);
                    previous.current = null;
                  }}
                >
                  {snapshot.runs?.map((run) => (
                    <option key={run.id} value={run.id}>
                      {new Intl.DateTimeFormat(localeTag, {
                        dateStyle: 'short',
                        timeStyle: 'medium',
                        timeZone: snapshot.timeZone,
                      }).format(new Date(run.createdAt))}
                    </option>
                  ))}
                </SelectField>
              )}
              <ul className="divide-y divide-border">
                {snapshot?.questions.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-4"
                  >
                    <div className="min-w-0 flex-1">
                      <Button
                        variant="ghost"
                        className="h-auto max-w-full justify-start whitespace-normal text-left"
                        disabled={busy || !item.canChoose}
                        onClick={() => choose(item.id, item.answered)}
                      >
                        {markdownSummary(item.preview) || t('Вопрос')}
                      </Button>
                      <p className="mt-1 flex items-center gap-2 text-xs text-muted">
                        {item.answered && (
                          <Check
                            aria-hidden="true"
                            className="size-3.5 text-success-ink"
                          />
                        )}
                        {item.answered
                          ? t('Ответ сохранен')
                          : item.state === 'scheduled'
                            ? t('Ожидание открытия')
                            : item.canChoose
                              ? t('Без ответа')
                              : t('Сначала ответьте на обязательный вопрос')}
                        {item.state === 'closed' ? t(' · Закрыт') : ''}
                      </p>
                    </div>
                    <Countdown
                      at={
                        item.state === 'scheduled'
                          ? item.scheduledAt
                          : item.state === 'open'
                            ? item.closesAt
                            : null
                      }
                      kind={item.state === 'scheduled' ? 'start' : 'close'}
                      timeZone={snapshot?.timeZone}
                    />
                  </li>
                ))}
              </ul>
              {snapshot?.questions.length === 0 && (
                <p className="text-sm text-muted">{t('Вопросов пока нет')}</p>
              )}
              <Pagination
                label={t('Страницы вопросов участника')}
                page={cursors.length}
                hasNext={Boolean(snapshot?.nextCursor)}
                busy={busy}
                onPrevious={() => setCursors((value) => value.slice(0, -1))}
                onNext={() =>
                  snapshot?.nextCursor &&
                  setCursors((value) => [...value, snapshot.nextCursor!])
                }
              />
            </Panel>
          )}
        </TabPanel>
        {snapshot?.resultsAvailable && (
          <TabPanel group="participant-tabs" id="results" value={section}>
            {section === 'results' && snapshot?.resultsAvailable && (
              <Results
                id={linkId}
                admin={false}
                runId={runId}
                onDenied={onDenied}
              />
            )}
          </TabPanel>
        )}
      </TabPanels>
    </div>
  );
}
