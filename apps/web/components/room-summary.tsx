'use client';
import {useEffect, useState} from 'react';
import {ChartColumn, Check, Download, Users} from 'lucide-react';
import {useLive} from '../lib/use-live';
import {publicRoomReport, type RoomReport} from '../lib/room-report';
import {markdownSummary} from '../lib/markdown';
import {Panel} from './ui/panel';
import {Button} from './ui/button';
import {Loading, Spinner} from './ui/loading';

const sources: Record<string, string> = {
  personal: 'Персональные ссылки',
  reusable: 'Многоразовые ссылки',
  admin_manual: 'Ручной ввод',
};

// Use the same filtered snapshot for counters and charts
export function RoomSummary({
  id,
  admin,
  runId,
  onDenied,
}: {
  id: string;
  admin: boolean;
  runId?: string | null;
  onDenied: () => void;
}) {
  const live = useLive(
    `/api/${admin ? 'rooms' : 'vote'}/${id}/events`,
    onDenied,
  );
  const [report, setReport] = useState<RoomReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [exportError, setExportError] = useState(false);
  const path = `/api/${admin ? 'rooms' : 'vote'}/${id}/results`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Reconcile after a missed event as well as after live changes
    async function load() {
      try {
        const query = new URLSearchParams({view: 'summary'});
        if (runId) query.set('run', runId);
        const response = await fetch(`${path}?${query}`, {
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
        if (response.status === 403) {
          setReport(null);
          setUnavailable(true);
          setFailed(false);
          return;
        }
        const data = await response.json();
        const current = publicRoomReport(data.report, admin);
        if (!response.ok || !current) throw new Error();
        setReport(current);
        setUnavailable(false);
        setFailed(false);
      } catch {
        if (!controller.signal.aborted) {
          setReport(null);
          setFailed(true);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void load(), live.connected ? 30000 : 2000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, admin, runId, onDenied, live.version, live.connected]);
  // Download one complete server snapshot with no private browser cache
  async function download() {
    if (downloading) return;
    setDownloading(true);
    setExportError(false);
    try {
      const query = new URLSearchParams({format: 'xlsx'});
      if (runId) query.set('run', runId);
      const response = await fetch(`${path}?${query}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (!response.ok) throw new Error();
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'results.xlsx';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setExportError(true);
    } finally {
      setDownloading(false);
    }
  }
  if (unavailable) return null;
  return (
    <Panel aria-label="Общие результаты">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="inline-flex items-center gap-2 text-lg font-semibold">
          <ChartColumn aria-hidden="true" className="size-5" />
          Общие результаты
        </h2>
        {report && (
          <Button
            variant="secondary"
            startIcon={downloading ? <Spinner /> : <Download />}
            disabled={downloading}
            onClick={() => void download()}
          >
            {downloading ? 'Готовим XLSX…' : 'Скачать XLSX'}
          </Button>
        )}
      </div>
      {loading && <Loading label="Загружаем сводку…" rows={2} />}
      {failed && (
        <p role="alert" className="text-sm text-error-ink">
          Не удалось загрузить сводку
        </p>
      )}
      {exportError && (
        <p role="alert" className="mb-4 text-sm text-error-ink">
          Не удалось скачать XLSX, попробуйте снова
        </p>
      )}
      {report && (
        <>
          <dl className="mb-5 grid grid-cols-2 gap-4">
            <div>
              <dt className="flex items-center gap-2 text-sm text-muted">
                <Users aria-hidden="true" className="size-4" />
                Проголосовало
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {report.participants}
              </dd>
            </div>
            <div>
              <dt className="flex items-center gap-2 text-sm text-muted">
                <Check aria-hidden="true" className="size-4" />
                Ответы
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">
                {report.answers}
              </dd>
            </div>
          </dl>
          <div className="grid gap-6 lg:grid-cols-2">
            <Bars
              title="Ответы по вопросам"
              items={report.questions.slice(0, 10).map((q) => ({
                id: q.id,
                label: markdownSummary(q.content) || 'Без текста',
                count: q.answers,
              }))}
            />
            <Bars
              title="Источники ответов"
              items={report.sources.map((source) => ({
                id: source.kind,
                label: sources[source.kind],
                count: source.answers,
              }))}
            />
            {admin && (
              <>
                <Bars
                  title="Ответы по ссылкам"
                  items={report.links.slice(0, 10).map((link) => ({
                    id: link.id,
                    label: `${link.name} (участников: ${link.participants})`,
                    count: link.answers,
                  }))}
                />
                <Bars
                  title="Многоразовые ссылки"
                  items={report.links
                    .filter((link) => link.mode === 'reusable')
                    .slice(0, 10)
                    .map((link) => ({
                      id: link.id,
                      label: `${link.name} (участников: ${link.participants})`,
                      count: link.answers,
                    }))}
                />
              </>
            )}
          </div>
          <p className="mt-5 text-xs leading-5 text-muted">
            Скрытые до окончания вопросы не учитываются
            {admin
              ? ', разбивка по ссылкам и участникам исключает анонимные вопросы'
              : ''}
          </p>
        </>
      )}
    </Panel>
  );
}

// Keep chart labels readable without depending on color alone
function Bars({
  title,
  items,
}: {
  title: string;
  items: {id: string; label: string; count: number}[];
}) {
  const maximum = Math.max(1, ...items.map((item) => item.count));
  return (
    <section>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      {!items.length ? (
        <p className="text-xs text-muted">Нет ответов</p>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <div className="mb-1 flex min-w-0 justify-between gap-3 text-xs">
                <span className="min-w-0 break-words">{item.label}</span>
                <span className="shrink-0 tabular-nums">{item.count}</span>
              </div>
              <div
                aria-hidden="true"
                className="h-2 overflow-hidden rounded-full bg-accent"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{width: `${(item.count / maximum) * 100}%`}}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
