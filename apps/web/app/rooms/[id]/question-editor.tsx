'use client';

import {useId, useState, type FormEvent} from 'react';
import {ArrowDown, ArrowUp, Plus, Trash2} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Form} from '../../../components/ui/form';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {TextField} from '../../../components/ui/text-field';
import {TextareaField} from '../../../components/ui/textarea-field';
import {SelectField} from '../../../components/ui/select-field';
import {CheckboxField} from '../../../components/ui/checkbox-field';
import {
  emptyQuestion,
  isQuestion,
  isQuestionInput,
  questionInput,
  type Choice,
  type Question,
  type QuestionInput,
} from '../../../lib/questions';

interface EditorChoice extends Choice {
  // Keep focus stable when unsaved options move
  localKey: string;
}
// Give unsaved options local keys without sending them to the API
function editorValue(value: QuestionInput) {
  return {
    ...questionInput(value),
    choices: value.choices.map((choice) => ({
      ...choice,
      localKey: choice.id ?? crypto.randomUUID(),
    })),
  };
}

// Edit source text and question settings as one draft
export function QuestionEditor({
  roomId,
  question,
  onSaved,
  onClose,
  onDenied,
  onReload,
}: {
  // Room that owns this draft
  roomId: string;
  // Saved draft, or null for a new one
  question: Question | null;
  // Show the new revision after saving
  onSaved: (value: Question) => void;
  // Return to the list
  onClose: () => void;
  // Leave private tools when access is lost
  onDenied: () => void;
  // Replace this form with the current saved version
  onReload: () => void;
}) {
  // Keep unsaved changes separate from the server version
  const [value, setValue] = useState(() =>
    editorValue(question ?? emptyQuestion()),
  );
  // Block repeated saves while a request is running
  const [busy, setBusy] = useState(false);
  // Save or validation error
  const [error, setError] = useState('');
  // Whether the saved version changed in another tab
  const [conflict, setConflict] = useState(false);
  const prefix = useId();
  const locked = question?.editLocked === true;

  // Change one field while preserving the rest of the draft
  function field<K extends keyof QuestionInput>(
    name: K,
    next: QuestionInput[K],
  ) {
    setValue((old) => ({...old, [name]: next}));
  }
  // Keep selection limits valid when the option list gets shorter
  function choices(next: EditorChoice[]) {
    const maximum = Math.min(value.maxChoices, Math.max(1, next.length));
    setValue((old) => ({
      ...old,
      choices: next,
      maxChoices: maximum,
      minChoices: Math.min(old.minChoices, maximum),
    }));
  }
  // Move options without replacing their saved identities
  function move(index: number, step: number) {
    const next = [...value.choices];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    choices(next);
  }
  // Send the version we loaded so another admin edit is not overwritten
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked) return;
    if (!isQuestionInput(value)) {
      setError('Проверьте размер текста, варианты и границы выбора');
      return;
    }
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/questions${question ? `/${question.id}` : ''}`,
        {
          method: question ? 'PATCH' : 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            ...questionInput(value),
            ...(question ? {revision: question.revision} : {}),
          }),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      // Keep local text on screen after a conflicting save
      if (response.status === 409) {
        setConflict(true);
        setError(
          body.error === 'locked'
            ? 'Редактирование этого вопроса запрещено'
            : 'Вопрос изменен в другой вкладке, ваши правки не сохранены',
        );
        return;
      }
      if (!response.ok || !isQuestion(body.question))
        throw new Error('Save failed');
      onSaved(body.question);
    } catch {
      setError('Не удалось сохранить вопрос, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <SectionHeader title={question ? 'Вопрос' : 'Новый вопрос'}>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          К списку
        </Button>
      </SectionHeader>
      <Form className="mt-5 space-y-6" onSubmit={(event) => void save(event)}>
        <fieldset disabled={busy || locked} className="min-w-0 space-y-6">
          <TextareaField
            id={`${prefix}-content`}
            label="Текст вопроса"
            hint="До 20 000 символов"
            value={value.content}
            rows={5}
            onChange={(event) => field('content', event.target.value)}
          />
          <div className="grid gap-5 sm:grid-cols-3">
            <SelectField
              id={`${prefix}-mode`}
              label="Выбор ответа"
              value={value.choiceMode}
              onChange={(event) => {
                const mode = event.target.value as QuestionInput['choiceMode'];
                setValue((old) => ({
                  ...old,
                  choiceMode: mode,
                  minChoices: 1,
                  maxChoices:
                    mode === 'single' ? 1 : Math.max(1, old.choices.length),
                }));
              }}
            >
              <option value="single">Один вариант</option>
              <option value="multiple">Несколько вариантов</option>
            </SelectField>
            {value.choiceMode === 'multiple' && (
              <>
                <TextField
                  id={`${prefix}-min`}
                  label="Минимум вариантов"
                  type="number"
                  min={1}
                  max={Math.max(1, value.choices.length)}
                  value={value.minChoices}
                  onChange={(event) =>
                    field('minChoices', Number(event.target.value))
                  }
                />
                <TextField
                  id={`${prefix}-max`}
                  label="Максимум вариантов"
                  type="number"
                  min={value.minChoices}
                  max={Math.max(1, value.choices.length)}
                  value={value.maxChoices}
                  onChange={(event) =>
                    field('maxChoices', Number(event.target.value))
                  }
                />
              </>
            )}
          </div>
          <section aria-label="Варианты ответа" className="space-y-4">
            <h3 className="font-semibold">Варианты ответа</h3>
            {value.choices.map((choice, index) => (
              <div
                key={choice.localKey}
                className="rounded-xl border border-border bg-page/50 p-4"
              >
                <TextareaField
                  id={`${prefix}-option-${choice.localKey}`}
                  label={`Вариант ${index + 1}`}
                  hint="До 5 000 символов"
                  value={choice.content}
                  rows={2}
                  onChange={(event) =>
                    setValue((old) => ({
                      ...old,
                      choices: old.choices.map((item, position) =>
                        position === index
                          ? {...item, content: event.target.value}
                          : item,
                      ),
                    }))
                  }
                />
                <div className="mt-2 flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    aria-label={`Поднять вариант ${index + 1}`}
                    startIcon={<ArrowUp />}
                    disabled={index === 0 || busy || locked}
                    onClick={() => move(index, -1)}
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Опустить вариант ${index + 1}`}
                    startIcon={<ArrowDown />}
                    disabled={
                      index === value.choices.length - 1 || busy || locked
                    }
                    onClick={() => move(index, 1)}
                  />
                  <Button
                    variant="ghost"
                    aria-label={`Удалить вариант ${index + 1}`}
                    startIcon={<Trash2 />}
                    onClick={() =>
                      choices(
                        value.choices.filter(
                          (_, position) => position !== index,
                        ),
                      )
                    }
                  />
                </div>
              </div>
            ))}
            <Button
              variant="secondary"
              startIcon={<Plus />}
              disabled={value.choices.length >= 100 || busy || locked}
              onClick={() =>
                choices([
                  ...value.choices,
                  {content: '', localKey: crypto.randomUUID()},
                ])
              }
            >
              Добавить вариант
            </Button>
          </section>
          <section
            aria-label="Настройки вопроса"
            className="space-y-4 border-t border-border pt-5"
          >
            <h3 className="font-semibold">Настройки вопроса</h3>
            <CheckboxField
              id={`${prefix}-results`}
              label="Публиковать результаты участникам"
              checked={value.shareResults}
              onChange={(event) => field('shareResults', event.target.checked)}
            />
            {value.shareResults && (
              <SelectField
                id={`${prefix}-publication`}
                label="Когда публиковать результаты"
                value={value.publication}
                onChange={(event) =>
                  field(
                    'publication',
                    event.target.value as QuestionInput['publication'],
                  )
                }
              >
                <option value="after_answer">После ответа</option>
                <option value="after_close">После закрытия вопроса</option>
              </SelectField>
            )}
            <CheckboxField
              id={`${prefix}-hide`}
              label="Скрывать результаты до окончания голосования, включая администратора"
              checked={value.hideResultsUntilEnd}
              onChange={(event) =>
                field('hideResultsUntilEnd', event.target.checked)
              }
            />
            <CheckboxField
              id={`${prefix}-change`}
              label="Разрешить изменение ответа"
              checked={value.allowAnswerChange}
              onChange={(event) =>
                field('allowAnswerChange', event.target.checked)
              }
            />
            <CheckboxField
              id={`${prefix}-anonymous`}
              label="Анонимные ответы"
              disabled={
                busy ||
                locked ||
                Boolean(question && question.state !== 'draft')
              }
              hint="В результатах не будет видно, с какой ссылки получен ответ"
              checked={value.anonymous}
              onChange={(event) => field('anonymous', event.target.checked)}
            />
          </section>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-error-ink">
            {error}
          </p>
        )}
        {conflict && (
          <Button variant="secondary" onClick={onReload}>
            Загрузить актуальную версию
          </Button>
        )}
        {!locked && (
          <Button type="submit" disabled={busy}>
            {busy
              ? 'Сохраняем…'
              : question && question.state !== 'draft'
                ? 'Сохранить изменения'
                : 'Сохранить черновик'}
          </Button>
        )}
        {locked && (
          <p className="text-xs text-muted">
            Администратор не может редактировать этот вопрос
          </p>
        )}
      </Form>
    </Panel>
  );
}
