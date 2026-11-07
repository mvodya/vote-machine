'use client';
import {useId, useRef, useState} from 'react';
import {ArrowRight, LoaderCircle, RotateCcw, SkipForward} from 'lucide-react';
import type {Question} from '../../../lib/questions';
import type {AnswerForm} from './answer-form';
import {useI18n} from '../../../components/language-provider';
import {Markdown} from '../../../components/markdown';
import {Button} from '../../../components/ui/button';
import {ChoiceField} from '../../../components/ui/choice-field';
import {isAnswer, type Answer} from '../../../lib/ballots';
import {markdownSummary} from '../../../lib/markdown';
import {playSound} from '../../../lib/audio';

// Confirm each click on the server before changing the visible selection
export function AllocationForm({
  question,
  answer,
  linkId,
  submitPath,
  extraPayload,
  existingRevision,
  onSaved,
  onSelectionSaved,
  onSelectionStart,
  onRefresh,
  onDenied,
  onSkip,
  onBusy,
}: Parameters<typeof AnswerForm>[0]) {
  const {t} = useI18n();
  const prefix = useId();
  const [local, setSaved] = useState<Answer | null>(null);
  const saved =
    local && (!answer || BigInt(local.revision) > BigInt(answer.revision))
      ? local
      : answer;
  const [requested, setRequested] = useState<string[] | null>(null);
  const [canRetry, setCanRetry] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Anonymous manual answers need one stable identity across immediate clicks
  const manualId = useRef<string | null>(null);
  const pending = useRef<{ids: string[]; body: Record<string, unknown>} | null>(
    null,
  );
  const lock = useRef(false);
  const committed = saved?.choices ?? [];
  const selected = requested ?? committed;
  const editable = question.state === 'open';
  const complete = committed.length >= question.minChoices;
  const viewer = submitPath
    ? {roomId: question.roomId}
    : {roomId: question.roomId, linkId};
  // Reconcile this browser's changes with the same snapshot as the free count
  function remaining(choice: Question['choices'][number]) {
    const before = answer?.choices.includes(choice.id!) ? 1 : 0;
    const after = selected.includes(choice.id!) ? 1 : 0;
    return Math.max(0, (choice.remaining ?? 0) + before - after);
  }
  const visible = question.choices.filter(
    (choice) =>
      question.hideUnavailable === false ||
      selected.includes(choice.id!) ||
      remaining(choice) > 0,
  );

  // A failed transfer rolls back its releases and can be retried unchanged
  async function save(ids: string[], retry = false) {
    if (lock.current || (!editable && !retry)) return;
    lock.current = true;
    setRequested(ids);
    onSelectionStart?.();
    setBusy(true);
    onBusy(true);
    setError('');
    setCanRetry(false);
    if (!retry || !pending.current) {
      manualId.current ??= crypto.randomUUID();
      pending.current = {
        ids,
        body: {
          requestId: crypto.randomUUID(),
          questionRevision: question.revision,
          ballotRevision: saved?.revision ?? existingRevision ?? '0',
          ...extraPayload,
          ...(submitPath && !extraPayload?.linkId
            ? {ballotId: extraPayload?.ballotId ?? manualId.current}
            : {}),
          choices: ids,
        },
      };
    }
    try {
      const response = await fetch(
        submitPath ?? `/api/vote/${linkId}/answers/${question.id}`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify(pending.current.body),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (response.status === 409) {
        pending.current = null;
        setRequested(null);
        const message =
          body.error === 'full'
            ? 'Этот вариант уже занят, выберите другой'
            : body.error === 'used'
              ? 'Выбранные варианты нельзя освободить или заменить'
              : body.error === 'closed'
                ? 'Вопрос закрыт, выбор не изменен'
                : 'Вопрос или ваш ответ изменился, проверьте актуальные данные';
        setError(message);
        if (!submitPath) onRefresh(t(message));
        return;
      }
      if (
        !response.ok ||
        !isAnswer(body.answer) ||
        body.answer.questionId !== question.id
      )
        throw new Error();
      pending.current = null;
      setSaved(body.answer);
      setRequested(null);
      playSound('submit', `allocation:${crypto.randomUUID()}`);
      onSelectionSaved?.();
    } catch {
      setCanRetry(true);
      setError('Не удалось подтвердить выбор, повторите попытку');
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <div className="space-y-5">
      <Markdown source={question.content} viewer={viewer} />
      <div className="flex min-h-5 items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {t('Выбрано {count} из {max}, минимум {min}', {
            count: selected.length,
            max: question.maxChoices,
            min: question.minChoices,
          })}
        </p>
        <span className="inline-flex size-4 shrink-0">
          {busy && (
            <LoaderCircle
              role="status"
              aria-label={t('Сохраняем…')}
              className="size-4 text-muted motion-safe:animate-spin"
            />
          )}
        </span>
      </div>
      {saved?.hidden && (
        <p role="status" className="text-sm text-muted">
          {t('Ответ сохранен с другого устройства')}
        </p>
      )}
      {question.state === 'closed' && (
        <p className="text-sm text-muted">{t('Вопрос закрыт')}</p>
      )}
      <fieldset
        disabled={busy || canRetry || !editable}
        className="min-w-0 space-y-3"
      >
        <legend className="sr-only">{t('Варианты ответа')}</legend>
        {visible.map((choice) => {
          const checked = selected.includes(choice.id!);
          const fixed = !question.allowAnswerChange && checked;
          const atLimit =
            selected.length >= question.maxChoices &&
            !checked &&
            (question.choiceMode !== 'single' || !question.allowAnswerChange);
          const unavailable =
            !editable ||
            fixed ||
            atLimit ||
            (!checked && remaining(choice) === 0) ||
            Boolean(saved?.hidden && !question.allowAnswerChange);
          return (
            <ChoiceField
              key={choice.id}
              id={`${prefix}-${choice.id}`}
              label={markdownSummary(choice.content)}
              multiple
              checked={checked}
              disabled={busy || canRetry || unavailable}
              dimDisabled={unavailable}
              onChange={() => {
                const ids = checked
                  ? selected.filter((id) => id !== choice.id)
                  : question.choiceMode === 'single'
                    ? [choice.id!]
                    : [...selected, choice.id!];
                void save(ids);
              }}
            >
              <Markdown source={choice.content} viewer={viewer} />
              <span className="mt-2 block text-xs text-muted">
                {t('Свободно мест: {count}', {count: remaining(choice)})}
              </span>
            </ChoiceField>
          );
        })}
      </fieldset>
      {visible.length === 0 && (
        <p className="text-sm text-muted">
          {t('Свободных вариантов пока нет')}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-ink">
          {t(error)}
        </p>
      )}
      <div className="flex min-h-11 flex-wrap gap-3">
        {canRetry && !busy && (
          <Button
            variant="secondary"
            startIcon={<RotateCcw />}
            onClick={() => void save(pending.current!.ids, true)}
          >
            {t('Повторить попытку')}
          </Button>
        )}
        {complete && !saved?.hidden && (
          <Button
            startIcon={<ArrowRight />}
            disabled={busy || canRetry}
            onClick={onSaved}
          >
            {t('Продолжить')}
          </Button>
        )}
        {!complete && editable && question.allowSkip && !submitPath && (
          <Button
            variant="secondary"
            startIcon={<SkipForward />}
            disabled={busy}
            onClick={onSkip}
          >
            {t('Пропустить вопрос')}
          </Button>
        )}
      </div>
      {question.editLocked && (
        <p className="text-xs text-muted">
          {t('Администратор не может редактировать этот вопрос')}
        </p>
      )}
      {question.anonymous && (
        <p className="text-xs text-muted">
          {t('Администратор не видит, с какой ссылки получен ответ')}
        </p>
      )}
    </div>
  );
}
