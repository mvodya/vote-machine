'use client';
import {useId, useRef, useState, type FormEvent} from 'react';
import {Check, SkipForward} from 'lucide-react';
import {formatTime, localTimeZone} from '../../../lib/time';
import {Markdown} from '../../../components/markdown';
import {Button} from '../../../components/ui/button';
import {Form} from '../../../components/ui/form';
import {ChoiceField} from '../../../components/ui/choice-field';
import {markdownSummary} from '../../../lib/markdown';
import {isAnswer, type Answer} from '../../../lib/ballots';
import type {Question} from '../../../lib/questions';

// Keep a failed request identity so a retry cannot create a second vote
export function AnswerForm({
  linkId,
  timeZone = localTimeZone(),
  question,
  answer,
  onSaved,
  onRefresh,
  onDenied,
  onSkip,
  onBusy,
}: {
  // Current participant and question
  timeZone?: string;
  linkId: string;
  question: Question;
  answer: Answer | null;
  // Advance only after the server confirms the saved answer
  onSaved: () => void;
  // Refresh a closed or changed question
  onRefresh: (notice: string) => void;
  // Leave private content after access is lost
  onDenied: () => void;
  // Temporarily move past a question that permits it
  onSkip: () => void;
  // Keep navigation still while a vote is saving
  onBusy: (value: boolean) => void;
}) {
  const [selected, setSelected] = useState<string[]>(answer?.choices ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef<{
    signature: string;
    body: Record<string, unknown>;
  } | null>(null);
  const prefix = useId();
  const canVote =
    question.state === 'open' && (!answer || question.allowAnswerChange);
  const viewer = {roomId: question.roomId, linkId};
  // Submit one selection with both content and answer versions
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !canVote) return;
    if (
      selected.length < question.minChoices ||
      selected.length > question.maxChoices
    ) {
      setError(
        `Выберите от ${question.minChoices} до ${question.maxChoices} вариантов`,
      );
      return;
    }
    const ids = [...selected].sort();
    const signature = JSON.stringify([
      question.revision,
      answer?.revision ?? '0',
      ids,
    ]);
    if (pending.current?.signature !== signature)
      pending.current = {
        signature,
        body: {
          requestId: crypto.randomUUID(),
          questionRevision: question.revision,
          ballotRevision: answer?.revision ?? '0',
          choices: ids,
        },
      };
    setBusy(true);
    onBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/vote/${linkId}/answers/${question.id}`,
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
        onRefresh(
          body.error === 'closed'
            ? 'Вопрос закрыт, ответ не принят'
            : body.error === 'used'
              ? 'Ваш ответ уже сохранен'
              : body.error === 'sequence'
                ? 'Сначала ответьте на обязательный вопрос'
                : 'Вопрос или ваш ответ изменился, проверьте актуальные данные',
        );
        return;
      }
      if (
        !response.ok ||
        !isAnswer(body.answer) ||
        body.answer.questionId !== question.id
      )
        throw new Error();
      pending.current = null;
      onSaved();
    } catch {
      setError('Не удалось подтвердить сохранение, попробуйте отправить снова');
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <>
      <Markdown source={question.content} viewer={viewer} />
      {question.closesAt && (
        <p className="mt-2 text-xs text-muted">
          Срок:{' '}
          <time dateTime={question.closesAt}>
            {formatTime(question.closesAt, timeZone)}
          </time>
        </p>
      )}
      {answer && (
        <p role="status" className="mt-4 text-sm text-success-ink">
          Ваш ответ сохранен
        </p>
      )}
      {question.state === 'closed' && (
        <p className="mt-3 text-sm text-muted">Вопрос закрыт</p>
      )}
      <Form className="mt-5" onSubmit={(event) => void submit(event)}>
        <fieldset disabled={busy || !canVote} className="space-y-3">
          <legend className="mb-3 text-sm font-medium">
            {question.choiceMode === 'single'
              ? 'Выберите один вариант'
              : `Выберите от ${question.minChoices} до ${question.maxChoices} вариантов`}
          </legend>
          {question.choices.map((choice, index) => (
            <ChoiceField
              key={choice.id}
              id={`${prefix}-${choice.id}`}
              label={markdownSummary(choice.content) || `Вариант ${index + 1}`}
              multiple={question.choiceMode === 'multiple'}
              checked={selected.includes(choice.id!)}
              disabled={busy || !canVote}
              onChange={() => {
                const id = choice.id!;
                setSelected((old) =>
                  question.choiceMode === 'single'
                    ? [id]
                    : old.includes(id)
                      ? old.filter((value) => value !== id)
                      : [...old, id],
                );
                setError('');
              }}
            >
              <Markdown source={choice.content} viewer={viewer} />
            </ChoiceField>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-error-ink">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          {canVote && (
            <Button type="submit" startIcon={<Check />} disabled={busy}>
              {busy
                ? 'Сохраняем…'
                : answer
                  ? 'Изменить ответ'
                  : 'Отправить ответ'}
            </Button>
          )}
          {question.state === 'open' && !answer && question.allowSkip && (
            <Button
              variant="secondary"
              startIcon={<SkipForward />}
              disabled={busy}
              onClick={onSkip}
            >
              Пропустить вопрос
            </Button>
          )}
        </div>
        {question.editLocked && (
          <p className="text-xs text-muted">
            Администратор не может редактировать этот вопрос
          </p>
        )}
        {question.anonymous && (
          <p className="text-xs text-muted">
            Администратор не видит, с какой ссылки получен ответ
          </p>
        )}
      </Form>
    </>
  );
}
