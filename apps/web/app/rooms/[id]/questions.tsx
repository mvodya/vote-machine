'use client';
import {useI18n} from '../../../components/language-provider';
import {QuestionTypeLabel} from '../../../components/question-type-label';
import {MenuButton} from '../../../components/ui/menu-button';
import {AnswerCount} from '../../../components/answer-count';
import {Loading} from '../../../components/ui/loading';
import {useLive} from '../../../lib/use-live';
import {useEffect, useRef, useState} from 'react';
import {Eye, ListChecks, Pencil, Plus, Trash2} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {EmptyState} from '../../../components/ui/empty-state';
import {Pagination} from '../../../components/ui/pagination';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {
  isQuestion,
  questionTypes,
  type QuestionType,
  isQuestionSummary,
  validQuestionCursor,
  type Question,
  type QuestionSummary,
} from '../../../lib/questions';
import {markdownSummary} from '../../../lib/markdown';
import {localTimeZone} from '../../../lib/time';
import {Countdown} from '../../../components/countdown';
import {QuestionAction} from '../../../components/question-action';
import {QuestionEditor} from './question-editor';
// Show question metadata and open the full editor on demand
export function Questions({
  roomId,
  onDenied,
  onEditingChange,
  timeZone = localTimeZone(),
  snapshot,
}: {
  // Local snapshots use the same view without server requests
  snapshot?: QuestionSummary[];
  // Room opened by the admin
  roomId: string;
  // Shared zone used in question dates
  timeZone?: string;
  // Leave private panels when the session is rejected
  onDenied: () => void;
  // Tell room tabs when the editor is open
  onEditingChange?: (value: boolean) => void;
}) {
  const {t} = useI18n();
  // Compare real snapshots so old closed questions do not flash on arrival
  const prior = useRef(new Map<string, string>());
  const closeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [recentlyClosed, setRecentlyClosed] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    const timers = closeTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  // Metadata for the current page
  const [loadedItems, setItems] = useState<QuestionSummary[]>([]);
  // Saved page boundaries
  const [cursors, setCursors] = useState(['0']);
  // Cursor for the next page
  const [next, setNext] = useState<string | null>(null);
  // List reload counter
  const [attempt, setAttempt] = useState(0);
  // Loading state for the page
  const [loading, setLoading] = useState(!snapshot);
  // Failure while reading the list
  const [failed, setFailed] = useState(false);
  // Block duplicate detail and delete requests
  const [busy, setBusy] = useState(false);
  // Saved question, new draft, or closed editor
  const [editing, setEditing] = useState<Question | 'new' | null>(null);
  // A stable editor session keeps its selected tab after saving
  const [editorSession, setEditorSession] = useState(0);
  const [newType, setNewType] = useState<QuestionType>('choice');
  // Draft selected for deletion
  const [reopening, setReopening] = useState<QuestionSummary | null>(null);
  const [deleting, setDeleting] = useState<QuestionSummary | null>(null);
  // Result or error shown below the current panel
  const [notice, setNotice] = useState('');
  const items = snapshot ?? loadedItems;
  const live = useLive(
    snapshot ? null : `/api/rooms/${roomId}/events`,
    onDenied,
  );
  const base = `/api/rooms/${roomId}/questions`;
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    // Local views must not read real room data
    if (snapshot) return;
    const controller = new AbortController();
    // Load only a small metadata page, without option bodies
    async function load() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setFailed(false);
      try {
        const response = await fetch(
          `${base}?after=${encodeURIComponent(cursor)}`,
          {
            cache: 'no-store',
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(12000),
            ]),
          },
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (!response.ok) throw new Error('Load failed');
        const body = await response.json();
        if (
          !Array.isArray(body.questions) ||
          !body.questions.every(isQuestionSummary) ||
          (body.nextCursor !== null && !validQuestionCursor(body.nextCursor))
        )
          throw new Error('Bad page');
        if (!controller.signal.aborted) {
          for (const item of body.questions as QuestionSummary[]) {
            if (
              prior.current.get(item.id) === 'open' &&
              item.state === 'closed'
            ) {
              setRecentlyClosed((old) => new Set([...old, item.id]));
              clearTimeout(closeTimers.current.get(item.id));
              closeTimers.current.set(
                item.id,
                setTimeout(() => {
                  setRecentlyClosed((old) => {
                    const next = new Set(old);
                    next.delete(item.id);
                    return next;
                  });
                  closeTimers.current.delete(item.id);
                }, 5000),
              );
            }
            prior.current.set(item.id, item.state);
          }
          prior.current = new Map(
            (body.questions as QuestionSummary[]).map((item) => [
              item.id,
              item.state,
            ]),
          );
          setItems(body.questions);
          setNext(body.nextCursor);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [base, cursor, attempt, onDenied, live.version, snapshot]);
  // Refresh after a change or a failed read
  function reload() {
    setAttempt((value) => value + 1);
  }
  // Keep the list usable if a full question cannot be loaded
  async function open(id: string) {
    if (busy) return;
    setOpening(true);
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${base}/${id}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (!response.ok) throw new Error('Load failed');
      const body = await response.json();
      if (!isQuestion(body.question) || body.question.id !== id)
        throw new Error('Bad question');
      setEditing(body.question);
      setEditorSession((value) => value + 1);
    } catch {
      setNotice('Не удалось открыть вопрос, обновите список');
    } finally {
      setOpening(false);
      setBusy(false);
    }
  }
  // Remove only the revision selected in the confirmation dialog
  async function remove() {
    if (!deleting || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${base}/${deleting.id}`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({revision: deleting.revision}),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (response.status === 409) {
        setNotice('Вопрос изменен или удаление запрещено, обновите список');
        return;
      }
      if (!response.ok) throw new Error('Delete failed');
      setDeleting(null);
      reload();
      setNotice('Вопрос удален');
    } catch {
      setNotice('Не удалось удалить вопрос');
    } finally {
      setBusy(false);
    }
  }
  // Quick actions use only the saved management settings
  async function toggle(item: QuestionSummary) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${base}/${item.id}/lifecycle`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action: item.state === 'open' ? 'close' : 'open',
          revision: item.revision,
        }),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error === 'deadline'
            ? 'Измените истекший срок в вопросе'
            : body.error === 'ready'
              ? 'Заполните вопрос и минимум два варианта'
              : 'Не удалось изменить состояние вопроса, обновите список',
        );
      reload();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Не удалось изменить состояние',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {opening ? (
        <Panel>
          <Loading label={t('Открываем вопрос…')} rows={4} />
        </Panel>
      ) : editing !== null ? (
        <QuestionEditor
          key={editorSession}
          roomId={roomId}
          initialType={newType}
          timeZone={timeZone}
          onDirtyChange={onEditingChange}
          question={editing === 'new' ? null : editing}
          onDenied={onDenied}
          onClose={() => {
            setEditing(null);
            onEditingChange?.(false);
            setNotice('');
            reload();
          }}
          onSaved={(value) => {
            setEditing(value);
            setNotice('Изменения сохранены');
            reload();
          }}
          onReload={() => {
            if (editing !== 'new') void open(editing.id);
          }}
        />
      ) : (
        <Panel>
          <SectionHeader title={t('Вопросы')}>
            <MenuButton
              label={t('Создать вопрос')}
              icon={<Plus />}
              disabled={busy}
              items={Object.keys(questionTypes).map((kind) => ({
                value: kind,
                label: <QuestionTypeLabel kind={kind as QuestionType} />,
              }))}
              onSelect={(kind) => {
                setNewType(kind as QuestionType);
                setEditorSession((value) => value + 1);
                setEditing('new');
                setNotice('');
              }}
            />
          </SectionHeader>
          {loading ? (
            <Loading label={t('Загружаем вопросы…')} />
          ) : failed ? (
            <div role="alert" className="py-8">
              <p>{t('Не удалось загрузить вопросы')}</p>
              <Button className="mt-3" onClick={reload}>
                {t('Попробовать снова')}
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={32} />}
              title={t('Вопросов пока нет')}
              description={t('Создайте черновик вопроса')}
            />
          ) : (
            <ul className="-mx-5 divide-y divide-border sm:-mx-6">
              {items.map((item) => (
                <li
                  key={item.id}
                  aria-label={markdownSummary(item.preview) || t('Без текста')}
                  className={`flex flex-col gap-3 px-5 py-5 sm:flex-row sm:px-6 sm:items-center sm:justify-between ${recentlyClosed.has(item.id) ? 'animate-question-closed' : ''}`}
                  data-recently-closed={
                    recentlyClosed.has(item.id) ? 'true' : undefined
                  }
                >
                  <div className="min-w-0">
                    <h3 className="font-medium whitespace-pre-wrap break-words">
                      {markdownSummary(item.preview) || t('Без текста')}
                    </h3>
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      <span>
                        {item.state === 'scheduled'
                          ? t('Ожидание открытия')
                          : item.state === 'draft'
                            ? t('Черновик')
                            : item.state === 'open'
                              ? t('Открыт')
                              : t('Закрыт')}
                      </span>
                      <QuestionTypeLabel kind={item.questionType} />
                      <span>
                        {item.choiceMode === 'single'
                          ? t('Один вариант')
                          : t('Несколько вариантов')}
                      </span>
                      <span>
                        {t('Вариантов: ')}
                        {item.choiceCount}
                      </span>
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <AnswerCount count={item.answerCount ?? 0} />
                    <span
                      aria-label={t('Смотрят вопрос: {value0}', {
                        value0: item.viewerCount ?? 0,
                      })}
                      className="inline-flex items-center gap-1 text-xs text-muted"
                    >
                      <Eye aria-hidden="true" className="size-4" />
                      {item.viewerCount ?? 0}
                    </span>
                    <Countdown
                      at={
                        item.state === 'scheduled'
                          ? item.scheduledAt
                          : item.state === 'open'
                            ? item.closesAt
                            : null
                      }
                      kind={item.state === 'scheduled' ? 'start' : 'close'}
                      timeZone={timeZone}
                    />
                    <QuestionAction
                      state={item.state}
                      busy={busy}
                      compact
                      name={markdownSummary(item.preview) || t('Без текста')}
                      onClick={() => {
                        if (item.state !== 'open' && item.editLocked !== null)
                          setReopening(item);
                        else void toggle(item);
                      }}
                    />
                    <Button
                      variant="secondary"
                      startIcon={item.editLocked ? <Eye /> : <Pencil />}
                      disabled={busy}
                      onClick={() => void open(item.id)}
                    >
                      {item.editLocked ? t('Просмотреть') : t('Редактировать')}
                    </Button>
                    {
                      <Button
                        variant="ghost"
                        title={t('Удалить вопрос')}
                        aria-label={t('Удалить вопрос: {value0}', {
                          value0:
                            markdownSummary(item.preview) || t('Без текста'),
                        })}
                        startIcon={<Trash2 />}
                        disabled={busy}
                        onClick={() => {
                          setDeleting(item);
                          setNotice('');
                        }}
                      />
                    }
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !failed && (
            <Pagination
              label={t('Страницы вопросов')}
              page={cursors.length}
              hasNext={Boolean(next)}
              busy={busy}
              onPrevious={() => {
                setLoading(true);
                setCursors((value) => value.slice(0, -1));
              }}
              onNext={() => {
                if (next) {
                  setLoading(true);
                  setCursors((value) => [...value, next]);
                }
              }}
            />
          )}
        </Panel>
      )}
      <p role="status" className="mt-4 text-sm text-muted">
        {t(notice)}
      </p>
      {reopening && (
        <ConfirmDialog
          title={t('Открыть вопрос повторно?')}
          description={t(
            'Прежние ответы сохранятся Если включено скрытие результатов, они снова будут недоступны до окончания Уже увиденные итоги отозвать нельзя',
          )}
          confirmLabel={t('Открыть вопрос')}
          busy={busy}
          error={t(notice)}
          onClose={() => setReopening(null)}
          onConfirm={() => {
            void toggle(reopening).then(() => setReopening(null));
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('Удалить вопрос?')}
          description={t('Вопрос, его варианты и все ответы будут удалены')}
          confirmLabel={t('Удалить')}
          busy={busy}
          error={t(notice)}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
