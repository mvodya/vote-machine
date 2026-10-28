'use client';
import {useEffect, useRef, useState} from 'react';
import {ChartColumn, Download, Expand, Minimize, Monitor} from 'lucide-react';
import {useLive} from '../lib/use-live';
import {Countdown} from './countdown';
import {RoomSummary} from './room-summary';
import {Loading} from './ui/loading';
import {Panel} from './ui/panel';
import {Button} from './ui/button';
import {Pagination} from './ui/pagination';
import {EmptyState} from './ui/empty-state';
import {Markdown} from './markdown';
import {markdownSummary} from '../lib/markdown';
import {
  resultPage,
  publicResult,
  type VoteResult,
  type ResultPage,
} from '../lib/results';
const sourceNames: Record<string, string> = {
  personal: 'Персональные ссылки',
  admin_personal: 'Персональные ссылки',
  reusable: 'Многоразовые ссылки',
  admin_manual: 'Ручной ввод',
};
// Use one result view for admins and participants after server filtering
export function Results({
  id,
  admin,
  runId,
  onDenied,
  projector = false,
  initialQuestion,
}: {
  projector?: boolean;
  initialQuestion?: string;
  id: string;
  admin: boolean;
  runId?: string | null;
  onDenied: () => void;
}) {
  const live = useLive(
    `/api/${admin ? 'rooms' : 'vote'}/${id}/events`,
    onDenied,
  );
  const detailPanel = useRef<HTMLElement>(null);
  const scrollPending = useRef(false);
  const [page, setPage] = useState<ResultPage | null>(null);
  const [selected, setSelected] = useState<string | null>(
    initialQuestion ?? null,
  );
  const [result, setResult] = useState<VoteResult | null>(null);
  const [cursors, setCursors] = useState(['0']);
  const [peopleCursors, setPeopleCursors] = useState<string[]>(['']);
  const [failed, setFailed] = useState(false);
  const cursor = cursors[cursors.length - 1];
  const peopleCursor = peopleCursors[peopleCursors.length - 1];
  const path = `/api/${admin ? 'rooms' : 'vote'}/${id}/results`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const query = new URLSearchParams({after: cursor});
        if (projector) query.set('view', 'projector');
        if (runId) query.set('run', runId);
        const response = await fetch(`${path}?${query}`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        const list = resultPage(await response.json());
        if (!response.ok || !list) throw new Error();
        let detail: VoteResult | null = null;
        if (selected) {
          query.set('question', selected);
          if (peopleCursor) query.set('peopleAfter', peopleCursor);
          const item = await fetch(`${path}?${query}`, {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (item.status === 401) {
            onDenied();
            return;
          }
          if (item.status === 404) setSelected(null);
          if (item.status !== 404) {
            detail = publicResult((await item.json()).result, admin, projector);
            if (!item.ok || !detail) throw new Error();
          }
        }
        if (!controller.signal.aborted) {
          setPage(list);
          setResult(detail);
          setFailed(false);
        }
      } catch {
        if (!controller.signal.aborted) {
          setResult(null);
          setFailed(true);
        }
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
    path,
    cursor,
    selected,
    peopleCursor,
    admin,
    runId,
    onDenied,
    live.version,
    live.connected,
    projector,
  ]);
  // Scroll only after a deliberate phone selection, never on a live refresh
  useEffect(() => {
    if (!scrollPending.current || (!result && !failed)) return;
    scrollPending.current = false;
    if (matchMedia('(max-width: 1023px)').matches)
      detailPanel.current?.scrollIntoView({
        block: 'start',
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
      });
  }, [result, failed]);
  // Download a fresh authorized snapshot rather than a stale browser copy
  async function download() {
    const query = new URLSearchParams({question: selected!, format: 'csv'});
    if (runId) query.set('run', runId);
    try {
      const response = await fetch(`${path}?${query}`, {cache: 'no-store'});
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'results.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setResult(null);
      setFailed(true);
    }
  }
  return (
    <div className="space-y-5">
      {!projector && (
        <RoomSummary id={id} admin={admin} runId={runId} onDenied={onDenied} />
      )}
      <div
        className={
          projector
            ? 'mx-auto max-w-6xl space-y-5 p-4 sm:p-8 text-lg [&_p]:text-2xl'
            : `${!admin && page?.questions.length === 0 ? 'hidden' : 'grid'} items-start gap-5 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]`
        }
      >
        {projector && (
          <div className="flex justify-end gap-3">
            <Button
              variant="ghost"
              startIcon={<Expand />}
              onClick={() => {
                void document.documentElement
                  .requestFullscreen?.()
                  .catch(() => {});
              }}
            >
              На весь экран
            </Button>
            <a
              className="inline-flex items-center gap-2 rounded-xl px-3 text-sm"
              href={`/rooms/${id}`}
            >
              <Minimize className="size-4" />
              Вернуться в комнату
            </a>
          </div>
        )}
        {!projector && (
          <Panel>
            <h2 className="text-lg font-semibold">Результаты</h2>
            {page?.questions.length === 0 && (
              <EmptyState
                icon={<ChartColumn />}
                title="Результатов пока нет"
                description="Здесь появятся результаты голосования"
              />
            )}
            {!page && !failed && (
              <Loading label="Загружаем список результатов…" />
            )}
            <ul className="mt-4 divide-y divide-border">
              {page?.questions.map((question) => (
                <li key={question.id} className="py-2">
                  <Button
                    variant="ghost"
                    className="h-auto w-full justify-start whitespace-normal px-3 border border-transparent text-left aria-[current=true]:border-primary/35 aria-[current=true]:bg-selected aria-[current=true]:text-ink"
                    aria-label={`Результаты: ${markdownSummary(question.content) || 'Вопрос'}`}
                    aria-current={selected === question.id ? 'true' : undefined}
                    onClick={() => {
                      if (selected === question.id) {
                        if (matchMedia('(max-width: 1023px)').matches)
                          detailPanel.current?.scrollIntoView({
                            block: 'start',
                            behavior: matchMedia(
                              '(prefers-reduced-motion: reduce)',
                            ).matches
                              ? 'instant'
                              : 'smooth',
                          });
                        return;
                      }
                      scrollPending.current = true;
                      setSelected(question.id);
                      setPeopleCursors(['']);
                      setResult(null);
                    }}
                  >
                    {markdownSummary(question.content) || 'Вопрос'}
                  </Button>
                  {!question.available && (
                    <p className="mx-px px-3 text-xs text-muted">
                      Результаты пока недоступны
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <Pagination
              label="Страницы результатов"
              page={cursors.length}
              hasNext={Boolean(page?.nextCursor)}
              busy={false}
              onPrevious={() => setCursors((value) => value.slice(0, -1))}
              onNext={() =>
                page?.nextCursor &&
                setCursors((value) => [...value, page.nextCursor!])
              }
            />
          </Panel>
        )}
        <Panel
          ref={detailPanel}
          aria-label="Итоги вопроса"
          className="scroll-mt-5"
        >
          {selected && !result && !failed && (
            <Loading label="Загружаем результаты…" rows={2} />
          )}
          {failed && (
            <p role="alert" className="text-sm text-error-ink">
              Не удалось обновить результаты
            </p>
          )}
          {!projector && admin && selected && result && !result.available && (
            <a
              href={`/rooms/${id}?projector=1&question=${selected}`}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 inline-flex items-center gap-2 text-sm"
            >
              <Monitor className="size-4" />
              Открыть проектор
            </a>
          )}
          {!selected && <p className="text-sm text-muted">Выберите вопрос</p>}
          {projector && result?.content && !result.available && (
            <>
              <h1 className="text-2xl font-semibold">
                {markdownSummary(result.content)}
              </h1>
              <div className="my-6 flex justify-between gap-4">
                <span>Ответы: {result.answerCount ?? 0}</span>
                <Countdown
                  at={result.scheduledAt ?? result.closesAt}
                  kind={result.scheduledAt ? 'start' : 'close'}
                />
              </div>
            </>
          )}
          {result && !result.available && (
            <p className="text-sm text-muted">Результаты пока недоступны</p>
          )}
          {result?.available && (
            <>
              <Markdown
                source={result.content!}
                viewer={
                  admin
                    ? {roomId: result.roomId!}
                    : {roomId: result.roomId!, linkId: id}
                }
              />
              <p className="mt-4 font-medium">Ответы: {result.total}</p>
              <ul className="mt-4 space-y-4">
                {result.options?.map((option) => (
                  <li key={option.id}>
                    <Markdown
                      source={option.content}
                      viewer={
                        admin
                          ? {roomId: result.roomId!}
                          : {roomId: result.roomId!, linkId: id}
                      }
                    />
                    <div className="mt-2 flex justify-between text-sm tabular-nums">
                      <span>Голосов: {option.count}</span>
                      <span>{option.percent}%</span>
                    </div>
                    <div
                      className="mt-1 h-2 overflow-hidden rounded-full bg-accent"
                      aria-hidden="true"
                    >
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{width: `${option.percent}%`}}
                      />
                    </div>
                  </li>
                ))}
              </ul>
              {result.choiceMode === 'multiple' && (
                <p className="mt-4 text-xs text-muted">
                  Проценты от числа ответов, сумма может превышать 100%
                </p>
              )}
              {!projector && (
                <div className="mt-5 flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    startIcon={<Download />}
                    onClick={() => void download()}
                  >
                    Скачать CSV
                  </Button>
                  {admin && (
                    <a
                      href={`/rooms/${id}?projector=1&question=${selected}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm"
                    >
                      <Monitor className="size-4" />
                      Открыть проектор
                    </a>
                  )}
                </div>
              )}
              {result.sources && (
                <dl className="mt-5 space-y-2 text-sm">
                  {Object.entries(result.sources).map(([source, count]) => (
                    <div key={source} className="flex justify-between gap-3">
                      <dt>{sourceNames[source]}</dt>
                      <dd>{count}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {result.people && (
                <section className="mt-6 border-t border-border pt-4">
                  <h3 className="font-medium">Индивидуальные ответы</h3>
                  <ul className="mt-3 divide-y divide-border">
                    {result.people.map((person) => (
                      <li key={person.id} className="py-3 text-sm">
                        <p className="font-medium">
                          {person.name || sourceNames[person.source]}
                        </p>
                        <p className="mt-1 text-muted">
                          {person.choices
                            .map((choice) =>
                              markdownSummary(
                                result.options!.find(
                                  (option) => option.id === choice,
                                )!.content,
                              ),
                            )
                            .join(', ')}
                        </p>
                      </li>
                    ))}
                  </ul>
                  <Pagination
                    label="Страницы индивидуальных ответов"
                    page={peopleCursors.length}
                    hasNext={Boolean(result.nextPeopleCursor)}
                    busy={false}
                    onPrevious={() =>
                      setPeopleCursors((value) => value.slice(0, -1))
                    }
                    onNext={() =>
                      result.nextPeopleCursor &&
                      setPeopleCursors((value) => [
                        ...value,
                        result.nextPeopleCursor!,
                      ])
                    }
                  />
                </section>
              )}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
