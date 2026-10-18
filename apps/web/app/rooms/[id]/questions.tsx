'use client';

import {useEffect, useState} from 'react';
import {Eye, ListChecks, Pencil, Plus, RefreshCw, Trash2} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {EmptyState} from '../../../components/ui/empty-state';
import {Pagination} from '../../../components/ui/pagination';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {
  isQuestion,
  isQuestionSummary,
  validQuestionCursor,
  type Question,
  type QuestionSummary,
} from '../../../lib/questions';
import {markdownSummary} from '../../../lib/markdown';
import {QuestionEditor} from './question-editor';

// Show question metadata and open the full editor on demand
export function Questions({
  roomId,
  onDenied,
}: {
  // Room opened by the admin
  roomId: string;
  // Leave private panels when the session is rejected
  onDenied: () => void;
}) {
  // Metadata for the current page
  const [items, setItems] = useState<QuestionSummary[]>([]);
  // Saved page boundaries
  const [cursors, setCursors] = useState(['0']);
  // Cursor for the next page
  const [next, setNext] = useState<string | null>(null);
  // List reload counter
  const [attempt, setAttempt] = useState(0);
  // Loading state for the page
  const [loading, setLoading] = useState(true);
  // Failure while reading the list
  const [failed, setFailed] = useState(false);
  // Block duplicate detail and delete requests
  const [busy, setBusy] = useState(false);
  // Saved question, new draft, or closed editor
  const [editing, setEditing] = useState<Question | 'new' | null>(null);
  // Draft selected for deletion
  const [deleting, setDeleting] = useState<QuestionSummary | null>(null);
  // Result or error shown below the current panel
  const [notice, setNotice] = useState('');
  const base = `/api/rooms/${roomId}/questions`;
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    // Load only a small metadata page, without option bodies
    async function load() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
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
  }, [base, cursor, attempt, onDenied]);
  // Refresh after a change or a failed read
  function reload() {
    setAttempt((value) => value + 1);
  }
  // Keep the list usable if a full question cannot be loaded
  async function open(id: string) {
    if (busy) return;
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
    } catch {
      setNotice('Не удалось открыть вопрос, обновите список');
    } finally {
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
      setNotice('Черновик удален');
    } catch {
      setNotice('Не удалось удалить черновик');
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {editing !== null ? (
        <QuestionEditor
          key={editing === 'new' ? 'new' : `${editing.id}/${editing.revision}`}
          roomId={roomId}
          question={editing === 'new' ? null : editing}
          onDenied={onDenied}
          onClose={() => {
            setEditing(null);
            setNotice('');
            reload();
          }}
          onSaved={(value) => {
            setEditing(value);
            setNotice('Вопрос сохранен');
          }}
          onReload={() => {
            if (editing !== 'new') void open(editing.id);
          }}
        />
      ) : (
        <Panel>
          <SectionHeader title="Вопросы">
            <Button
              startIcon={<Plus />}
              disabled={busy}
              onClick={() => {
                setEditing('new');
                setNotice('');
              }}
            >
              Создать вопрос
            </Button>
          </SectionHeader>
          <div className="mt-4">
            <Button
              variant="ghost"
              startIcon={<RefreshCw />}
              disabled={loading || busy}
              onClick={reload}
            >
              Обновить
            </Button>
          </div>
          {loading ? (
            <p role="status" className="py-8 text-muted">
              Загружаем вопросы…
            </p>
          ) : failed ? (
            <div role="alert" className="py-8">
              <p>Не удалось загрузить вопросы</p>
              <Button className="mt-3" onClick={reload}>
                Попробовать снова
              </Button>
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={<ListChecks size={32} />}
              title="Вопросов пока нет"
              description="Создайте черновик вопроса"
            />
          ) : (
            <ul className="divide-y divide-border">
              {items.map((item) => (
                <li
                  key={item.id}
                  aria-label={markdownSummary(item.preview) || 'Без текста'}
                  className="flex flex-col gap-3 py-5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <h3 className="font-medium whitespace-pre-wrap break-words">
                      {markdownSummary(item.preview) || 'Без текста'}
                    </h3>
                    <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      <span>
                        {item.state === 'draft'
                          ? 'Черновик'
                          : item.state === 'open'
                            ? 'Открыт'
                            : 'Закрыт'}
                      </span>
                      <span>
                        {item.choiceMode === 'single'
                          ? 'Один вариант'
                          : 'Несколько вариантов'}
                      </span>
                      <span>Вариантов: {item.choiceCount}</span>
                      <time dateTime={item.createdAt}>
                        {new Date(item.createdAt).toLocaleString('ru-RU', {
                          timeZone: 'UTC',
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}{' '}
                        UTC
                      </time>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      startIcon={item.editLocked ? <Eye /> : <Pencil />}
                      disabled={busy}
                      onClick={() => void open(item.id)}
                    >
                      {item.editLocked ? 'Просмотреть' : 'Редактировать'}
                    </Button>
                    {item.state === 'draft' && (
                      <Button
                        variant="ghost"
                        title="Удалить черновик"
                        aria-label={`Удалить вопрос: ${markdownSummary(item.preview) || 'Без текста'}`}
                        startIcon={<Trash2 />}
                        disabled={busy}
                        onClick={() => {
                          setDeleting(item);
                          setNotice('');
                        }}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {!loading && !failed && (
            <Pagination
              label="Страницы вопросов"
              page={cursors.length}
              hasNext={Boolean(next)}
              busy={busy}
              onPrevious={() => setCursors((value) => value.slice(0, -1))}
              onNext={() => next && setCursors((value) => [...value, next])}
            />
          )}
        </Panel>
      )}
      <p role="status" className="mt-4 text-sm text-muted">
        {notice}
      </p>
      {deleting && (
        <ConfirmDialog
          title="Удалить черновик?"
          description="Черновик и его варианты будут удалены"
          confirmLabel="Удалить"
          busy={busy}
          error={notice}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(null)}
        />
      )}
    </>
  );
}
