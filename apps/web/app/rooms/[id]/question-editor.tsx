'use client';
import {useI18n} from '../../../components/language-provider';
import {useLive} from '../../../lib/use-live';
import {QuestionTypeLabel} from '../../../components/question-type-label';
import {QuestionAction} from '../../../components/question-action';
import {ExpectedLinks} from '../../../components/expected-links';
import {ManualVoting} from './manual-voting';
import {markdownAssets} from '../../../lib/markdown';
import {useCallback, useEffect, useId, useState, type FormEvent} from 'react';
import {
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  Save,
  LoaderCircle,
  Undo2,
  ArrowLeft,
  Pencil,
  Settings,
  Play,
  FilePenLine,
} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Form} from '../../../components/ui/form';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {TextField} from '../../../components/ui/text-field';
import {MarkdownField} from '../../../components/ui/markdown-field';
import {SelectField} from '../../../components/ui/select-field';
import {CheckboxField} from '../../../components/ui/checkbox-field';
import {
  emptyQuestion,
  isQuestion,
  isQuestionInput,
  questionInput,
  type QuestionType,
  type Choice,
  type Question,
  type QuestionInput,
} from '../../../lib/questions';
import {TabPanels} from '../../../components/ui/tab-panels';
import {TabPanel} from '../../../components/ui/tab-panel';
import {Tabs} from '../../../components/ui/tabs';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {
  QuestionDeadline,
  type DeadlineValue,
} from '../../../components/question-deadline';
import {
  formatTime,
  localTimeZone,
  wallTime,
  wallTimeToInstant,
} from '../../../lib/time';
interface EditorChoice extends Choice {
  // Keep focus stable when unsaved options move
  localKey: string;
}
// Keep local option keys outside the API document
function editorValue(value: QuestionInput) {
  return {
    ...questionInput(value),
    choices: value.choices.map((choice) => ({
      ...choice,
      localKey: choice.id ?? crypto.randomUUID(),
    })),
  };
}
// Read stored deadlines in the shared room zone
function deadlineValue(question: Question | null, zone: string): DeadlineValue {
  const seconds = question?.closeAfterSeconds ?? 600;
  const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  return {
    deadlineMode:
      question?.deadlineMode ?? (question?.closesAt ? 'absolute' : 'none'),
    wall: question?.closesAt ? wallTime(question.closesAt, zone) : '',
    duration: String(seconds / unit),
    unit: String(unit),
  };
}
// Reuse the same controls for a scheduled start
function startValue(question: Question | null, zone: string): DeadlineValue {
  const seconds = question?.startAfterSeconds ?? 600;
  const unit = seconds % 3600 === 0 ? 3600 : seconds % 60 === 0 ? 60 : 1;
  return {
    deadlineMode: question?.startMode ?? 'none',
    wall: question?.startsAt ? wallTime(question.startsAt, zone) : '',
    duration: String(seconds / unit),
    unit: String(unit),
  };
}
// Ignore inactive controls when checking for actual changes
function deadlineKey(value: DeadlineValue) {
  return value.deadlineMode === 'none'
    ? ['none']
    : value.deadlineMode === 'absolute'
      ? ['absolute', value.wall]
      : [
          'duration',
          Number(value.duration) * Number(value.unit) || value.duration,
        ];
}
// Save content, settings and lifecycle as one versioned document
export function QuestionEditor({
  roomId,
  question,
  initialType = 'choice',
  onSaved,
  onClose,
  onDenied,
  onReload,
  onDirtyChange,
  timeZone = localTimeZone(),
}: {
  // Room and saved question, or null for a new one
  roomId: string;
  question: Question | null;
  // A new draft keeps the type chosen in the creation menu
  initialType?: QuestionType;
  // Shared room zone used by all date controls
  timeZone?: string;
  // Show the confirmed document in the room
  onSaved: (value: Question) => void;
  // Return only after unsaved work is handled
  onClose: () => void;
  // Remove private content after access is lost
  onDenied: () => void;
  // Explicitly reload a conflicting version
  onReload: () => void;
  // Tell room navigation about unsaved work
  onDirtyChange?: (value: boolean) => void;
}) {
  const {t, localeTag} = useI18n();
  const [saved, setSaved] = useState(question);
  const fresh = () => {
    const draft = emptyQuestion();
    return {
      ...draft,
      questionType: initialType,
      ...(initialType === 'allocation' ? {hideUnavailable: true} : {}),
      choices: draft.choices.map((choice) => ({
        ...choice,
        ...(initialType === 'allocation' ? {capacity: 1} : {}),
      })),
    };
  };
  const [value, setValue] = useState(() => editorValue(question ?? fresh()));
  const [state, setState] = useState(question?.state ?? 'draft');
  const [deadline, setDeadline] = useState(() =>
    deadlineValue(question, timeZone),
  );
  const [start, setStart] = useState(() => startValue(question, timeZone));
  const live = useLive(`/api/rooms/${roomId}/events`, onDenied);
  const [section, setSection] = useState('editing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [makeDraft, setMakeDraft] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [electorateLoading, setElectorateLoading] = useState(false);
  const [reopen, setReopen] = useState(false);
  const [uploads, setUploads] = useState(0);
  const uploadChanged = useCallback(
    (delta: number) => setUploads((count) => Math.max(0, count + delta)),
    [],
  );
  const prefix = useId();
  const locked = saved?.editLocked === true;
  const dirty =
    uploads > 0 ||
    JSON.stringify([
      questionInput(value),
      state,
      deadlineKey(deadline),
      deadlineKey(start),
    ]) !==
      JSON.stringify([
        questionInput(saved ?? fresh()),
        saved?.state ?? 'draft',
        deadlineKey(deadlineValue(saved, timeZone)),
        deadlineKey(startValue(saved, timeZone)),
      ]);
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    const ids = [
      ...new Set(
        [
          value.content,
          ...value.choices.map((choice) => choice.content),
        ].flatMap(markdownAssets),
      ),
    ];
    if (!ids.length) return;
    const controller = new AbortController();
    // Active editing renews the grace period for detached files
    async function keepFiles() {
      try {
        await fetch(`/api/rooms/${roomId}/assets/keepalive`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ids}),
          signal: controller.signal,
        });
      } catch {}
    }
    const start = setTimeout(() => void keepFiles(), 1000);
    const timer = setInterval(() => void keepFiles(), 10 * 60 * 1000);
    return () => {
      clearTimeout(start);
      clearInterval(timer);
      controller.abort();
    };
  }, [roomId, value.content, value.choices]);
  useEffect(() => {
    if (!saved || dirty || busy || !live.version) return;
    const controller = new AbortController();
    async function update() {
      try {
        const response = await fetch(
          `/api/rooms/${roomId}/questions/${saved!.id}`,
          {cache: 'no-store', signal: controller.signal},
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (
          response.ok &&
          isQuestion(data.question) &&
          data.question.revision !== saved!.revision &&
          !controller.signal.aborted
        ) {
          setSaved(data.question);
          setState(data.question.state);
          setValue(editorValue(data.question));
          setDeadline(deadlineValue(data.question, timeZone));
          setStart(startValue(data.question, timeZone));
        }
      } catch {}
    }
    void update();
    return () => controller.abort();
  }, [live.version, roomId, saved, dirty, busy, onDenied, timeZone]);
  // Cancel only the armed start, keeping content and prior answers
  async function cancelStart() {
    if (!saved || busy || dirty) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/questions/${saved.id}/lifecycle`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            action: 'cancel_start',
            revision: saved.revision,
          }),
        },
      );
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();

      if (!response.ok || !isQuestion(body.question)) throw new Error();
      setReopen(false);
      setSaved(body.question);
      setState(body.question.state);
      onSaved(body.question);
    } catch {
      setError('Не удалось отменить запуск');
    } finally {
      setBusy(false);
    }
  }
  // Change one setting without replacing other local fields
  function field<K extends keyof QuestionInput>(
    name: K,
    next: QuestionInput[K],
  ) {
    setValue((old) => ({...old, [name]: next}));
  }
  // Keep selection limits valid after removing a choice
  function choices(next: EditorChoice[]) {
    const maximum = Math.min(value.maxChoices, Math.max(1, next.length));
    setValue((old) => ({
      ...old,
      choices: next,
      maxChoices: maximum,
      minChoices: Math.min(old.minChoices, maximum),
    }));
  }
  // Preserve saved option identity while changing order
  function move(index: number, step: number) {
    const next = [...value.choices];
    [next[index], next[index + step]] = [next[index + step], next[index]];
    choices(next);
  }
  // Restore all three tabs to the same saved version
  function reset() {
    setValue(editorValue(saved ?? fresh()));
    setState(saved?.state ?? 'draft');
    setDeadline(deadlineValue(saved, timeZone));
    setStart(startValue(saved, timeZone));
    setError('');
    setConflict(false);
    setDiscard(false);
  }
  // Commit all tabs together, including opening and closing
  async function save(
    event?: FormEvent<HTMLFormElement>,
    target?: Question['state'],
  ) {
    event?.preventDefault();
    if (busy || uploads > 0 || electorateLoading || (!dirty && !target)) return;
    if (
      target === 'open' &&
      saved?.editLocked !== null &&
      saved &&
      value.hideResultsUntilEnd &&
      !reopen
    ) {
      setReopen(true);
      return;
    }
    if (!isQuestionInput(value)) {
      setError('Проверьте размер текста, варианты и границы выбора');
      return;
    }
    setBusy(true);
    setError('');
    setConflict(false);
    try {
      let closesAt: string | null = null;
      let closeAfterSeconds: number | null = null;
      if (deadline.deadlineMode === 'absolute') {
        closesAt =
          saved?.closesAt &&
          deadline.wall === wallTime(saved.closesAt, timeZone)
            ? saved.closesAt
            : wallTimeToInstant(deadline.wall, timeZone);
      } else if (deadline.deadlineMode === 'duration') {
        closeAfterSeconds = Number(deadline.duration) * Number(deadline.unit);
        if (
          !Number.isInteger(closeAfterSeconds) ||
          closeAfterSeconds < 1 ||
          closeAfterSeconds > 2147483647
        )
          throw new Error('Укажите положительную длительность');
      }
      let startsAt: string | null = null;
      let startAfterSeconds: number | null = null;
      if (start.deadlineMode === 'absolute')
        startsAt =
          saved?.startsAt && start.wall === wallTime(saved.startsAt, timeZone)
            ? saved.startsAt
            : wallTimeToInstant(start.wall, timeZone);
      if (start.deadlineMode === 'duration') {
        startAfterSeconds = Number(start.duration) * Number(start.unit);
        if (
          !Number.isInteger(startAfterSeconds) ||
          startAfterSeconds < 1 ||
          startAfterSeconds > 2147483647
        )
          throw new Error('Укажите положительную задержку');
      }
      const response = await fetch(
        `/api/rooms/${roomId}/questions${saved ? `/${saved.id}` : ''}`,
        {
          method: saved ? 'PATCH' : 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            ...questionInput(value),
            state: target ?? state,
            startMode: start.deadlineMode,
            startsAt,
            startAfterSeconds,
            deadlineMode: deadline.deadlineMode,
            closesAt,
            closeAfterSeconds,
            ...(saved ? {revision: saved.revision} : {}),
          }),
          signal: AbortSignal.timeout(12000),
        },
      );
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok && body.error === 'type_fixed')
        throw new Error('Тип вопроса нельзя менять после выбора вариантов');
      if (!response.ok && body.error === 'capacity')
        throw new Error('Количество мест не может быть меньше числа занятых');
      if (!response.ok) {
        setConflict(body.error === 'conflict');
        throw new Error(
          body.error === 'complete'
            ? 'Все выбранные участники уже ответили, измените состав или выключите автозавершение'
            : body.error === 'electorate_locked'
              ? 'Состав фиксирован на время открытия'
              : body.error === 'electorate'
                ? 'Выберите действующие персональные ссылки'
                : body.error === 'used_options'
                  ? 'Нельзя удалить вариант, за который уже голосовали'
                  : body.error === 'ballots'
                    ? 'Новые границы выбора нарушают сохраненные ответы'
                    : body.error === 'asset'
                      ? 'Файл удален или недоступен, загрузите его снова'
                      : body.error === 'locked'
                        ? 'Редактирование содержимого этого вопроса запрещено'
                        : body.error === 'ready'
                          ? 'Для открытия нужен текст вопроса и минимум два непустых варианта'
                          : body.error === 'deadline'
                            ? 'Укажите будущий срок или уберите его'
                            : body.error === 'conflict'
                              ? 'Вопрос изменен в другой вкладке, ваши правки не сохранены'
                              : 'Не удалось сохранить вопрос, попробуйте снова',
        );
      }
      if (!isQuestion(body.question))
        throw new Error('Не удалось сохранить вопрос');
      setReopen(false);
      setSaved(body.question);
      setValue(editorValue(body.question));
      setState(body.question.state);
      setDeadline(deadlineValue(body.question, timeZone));
      setStart(startValue(body.question, timeZone));
      onSaved(body.question);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Не удалось сохранить вопрос, попробуйте снова',
      );
    } finally {
      setBusy(false);
    }
  }
  // Reset saved answers only after the explicit destructive action
  async function resetAnswers() {
    if (!saved || busy || dirty) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `/api/rooms/${roomId}/questions/${saved.id}/reset`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({revision: saved.revision}),
        },
      );
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok || !isQuestion(body.question))
        throw new Error('Не удалось сделать вопрос черновиком, обновите его');
      setReopen(false);
      setSaved(body.question);
      setValue(editorValue(body.question));
      setState(body.question.state);
      setDeadline(deadlineValue(body.question, timeZone));
      setStart(startValue(body.question, timeZone));
      setMakeDraft(false);
      onSaved(body.question);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Не удалось сбросить ответы',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <SectionHeader title={saved ? t('Вопрос') : t('Новый вопрос')}>
        <div className="flex flex-wrap gap-2">
          {dirty ? (
            <>
              <Button
                type="submit"
                form={`${prefix}-form`}
                startIcon={
                  busy ? (
                    <LoaderCircle className="motion-safe:animate-spin" />
                  ) : (
                    <Save />
                  )
                }
                disabled={busy || uploads > 0 || electorateLoading}
              >
                {busy ? t('Сохраняем…') : t('Сохранить изменения')}
              </Button>
              <Button
                variant="secondary"
                startIcon={<Undo2 />}
                disabled={busy || uploads > 0 || electorateLoading}
                onClick={() => setDiscard(true)}
              >
                {t('Отменить')}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              startIcon={<ArrowLeft />}
              onClick={onClose}
            >
              {t('Вернуться')}
            </Button>
          )}
        </div>
      </SectionHeader>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <QuestionTypeLabel kind={value.questionType} />
        {saved && (
          <time className="ml-auto" dateTime={saved.createdAt}>
            {formatTime(saved.createdAt, timeZone, localeTag)}
          </time>
        )}
      </div>
      <div className="mt-5">
        <Tabs
          label={t('Разделы вопроса')}
          group={prefix}
          value={section}
          onChange={setSection}
          items={[
            {
              id: 'editing',
              label: t('Редактирование'),
              icon: <Pencil />,
            },
            {
              id: 'settings',
              label: t('Настройки'),
              icon: <Settings />,
            },
            {
              id: 'management',
              label: t('Управление'),
              icon: <Play />,
            },
          ]}
        />
      </div>
      <Form
        id={`${prefix}-form`}
        className="mt-6 space-y-6"
        onSubmit={(event) => void save(event)}
      >
        <TabPanels group={prefix} value={section}>
          <TabPanel group={prefix} id="editing" value={section}>
            <fieldset disabled={busy || locked} className="min-w-0 space-y-6">
              <MarkdownField
                roomId={roomId}
                onUploadChange={uploadChanged}
                readOnly={locked}
                id={`${prefix}-content`}
                label={t('Текст вопроса')}
                hint={t('До 20 000 символов')}
                value={value.content}
                rows={5}
                onChange={(source) => field('content', source)}
              />

              <section aria-label={t('Варианты ответа')} className="space-y-4">
                <h3 className="font-semibold">{t('Варианты ответа')}</h3>
                {value.choices.map((choice, index) => (
                  <div
                    key={choice.localKey}
                    role="group"
                    aria-label={t('Настройки варианта {value0}', {
                      value0: index + 1,
                    })}
                    className="rounded-xl border border-border bg-page/50 p-4"
                  >
                    <MarkdownField
                      roomId={roomId}
                      onUploadChange={uploadChanged}
                      readOnly={locked}
                      id={`${prefix}-option-${choice.localKey}`}
                      label={t('Вариант {value0}', {value0: index + 1})}
                      hint={t('До 5 000 символов')}
                      value={choice.content}
                      rows={2}
                      onChange={(source) =>
                        setValue((old) => ({
                          ...old,
                          choices: old.choices.map((item, position) =>
                            position === index
                              ? {...item, content: source}
                              : item,
                          ),
                        }))
                      }
                    />
                    {value.questionType === 'allocation' && (
                      <div className="mt-5">
                        <TextField
                          id={`${prefix}-capacity-${choice.localKey}`}
                          label={t('Количество доступных мест')}
                          type="number"
                          min={1}
                          max={1000000}
                          value={choice.capacity ?? 1}
                          onChange={(event) =>
                            setValue((old) => ({
                              ...old,
                              choices: old.choices.map((item, position) =>
                                position === index
                                  ? {
                                      ...item,
                                      capacity: Number(event.target.value),
                                    }
                                  : item,
                              ),
                            }))
                          }
                        />
                      </div>
                    )}
                    <div className="mt-2 flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        aria-label={t('Поднять вариант {value0}', {
                          value0: index + 1,
                        })}
                        startIcon={<ArrowUp />}
                        disabled={index === 0 || busy || locked}
                        onClick={() => move(index, -1)}
                      />
                      <Button
                        variant="ghost"
                        aria-label={t('Опустить вариант {value0}', {
                          value0: index + 1,
                        })}
                        startIcon={<ArrowDown />}
                        disabled={
                          index === value.choices.length - 1 || busy || locked
                        }
                        onClick={() => move(index, 1)}
                      />
                      <Button
                        variant="ghost"
                        aria-label={t('Удалить вариант {value0}', {
                          value0: index + 1,
                        })}
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
                      {content: '', capacity: 1, localKey: crypto.randomUUID()},
                    ])
                  }
                >
                  {t('Добавить вариант')}
                </Button>
              </section>
            </fieldset>
          </TabPanel>
          <TabPanel
            group={prefix}
            id="settings"
            value={section}
            className="space-y-6"
          >
            <fieldset disabled={busy || locked}>
              {' '}
              <div className="grid gap-5 sm:grid-cols-3">
                <SelectField
                  id={`${prefix}-mode`}
                  label={t('Выбор ответа')}
                  value={value.choiceMode}
                  onChange={(event) => {
                    const mode = event.target
                      .value as QuestionInput['choiceMode'];
                    setValue((old) => ({
                      ...old,
                      choiceMode: mode,
                      minChoices: 1,
                      maxChoices:
                        mode === 'single' ? 1 : Math.max(1, old.choices.length),
                    }));
                  }}
                >
                  <option value="single">{t('Один вариант')}</option>
                  <option value="multiple">{t('Несколько вариантов')}</option>
                </SelectField>
                {value.choiceMode === 'multiple' && (
                  <>
                    <TextField
                      id={`${prefix}-min`}
                      label={t('Минимум вариантов')}
                      type="number"
                      min={0}
                      max={Math.max(1, value.choices.length)}
                      value={value.minChoices}
                      onChange={(event) =>
                        field('minChoices', Number(event.target.value))
                      }
                    />
                    <TextField
                      id={`${prefix}-max`}
                      label={t('Максимум вариантов')}
                      type="number"
                      min={Math.max(1, value.minChoices)}
                      max={Math.max(1, value.choices.length)}
                      value={value.maxChoices}
                      onChange={(event) =>
                        field('maxChoices', Number(event.target.value))
                      }
                    />
                  </>
                )}
              </div>
            </fieldset>
            <fieldset disabled={busy}>
              {' '}
              <section
                aria-label={t('Настройки вопроса')}
                className="space-y-4 border-t border-border pt-5"
              >
                <h3 className="font-semibold">{t('Настройки вопроса')}</h3>
                <CheckboxField
                  id={`${prefix}-results`}
                  label={t('Публиковать результаты участникам')}
                  checked={value.shareResults}
                  onChange={(event) =>
                    field('shareResults', event.target.checked)
                  }
                />
                {value.shareResults && (
                  <SelectField
                    id={`${prefix}-publication`}
                    label={t('Когда публиковать результаты')}
                    value={value.publication}
                    onChange={(event) =>
                      field(
                        'publication',
                        event.target.value as QuestionInput['publication'],
                      )
                    }
                  >
                    <option value="after_answer">{t('После ответа')}</option>
                    <option value="after_close">
                      {t('После закрытия вопроса')}
                    </option>
                  </SelectField>
                )}
                <CheckboxField
                  disabled={busy || state === 'open' || state === 'scheduled'}
                  id={`${prefix}-hide`}
                  label={t(
                    'Скрывать результаты до окончания голосования, включая администратора',
                  )}
                  checked={value.hideResultsUntilEnd}
                  onChange={(event) =>
                    field('hideResultsUntilEnd', event.target.checked)
                  }
                />
                <CheckboxField
                  id={`${prefix}-hide-content`}
                  label={t('Скрывать содержимое вопроса до открытия')}
                  checked={value.hideUntilOpen ?? false}
                  onChange={(event) =>
                    field('hideUntilOpen', event.target.checked)
                  }
                />
                <CheckboxField
                  id={`${prefix}-skip`}
                  label={t('Разрешить пропуск вопроса')}
                  checked={value.allowSkip ?? false}
                  onChange={(event) => field('allowSkip', event.target.checked)}
                />
                {value.questionType === 'allocation' && (
                  <CheckboxField
                    id={`${prefix}-hide-unavailable`}
                    label={t('Скрывать недоступные варианты')}
                    checked={value.hideUnavailable ?? true}
                    onChange={(event) =>
                      field('hideUnavailable', event.target.checked)
                    }
                  />
                )}
                <CheckboxField
                  id={`${prefix}-change`}
                  label={t('Разрешить изменение ответа')}
                  checked={value.allowAnswerChange}
                  onChange={(event) =>
                    field('allowAnswerChange', event.target.checked)
                  }
                />
                <CheckboxField
                  id={`${prefix}-anonymous`}
                  label={t('Анонимные ответы')}
                  disabled={
                    busy || (saved?.editLocked !== null && saved !== null)
                  }
                  hint={t(
                    'В результатах не будет видно, с какой ссылки получен ответ',
                  )}
                  checked={value.anonymous}
                  onChange={(event) => field('anonymous', event.target.checked)}
                />
              </section>
            </fieldset>
          </TabPanel>
          <TabPanel
            group={prefix}
            id="management"
            value={section}
            className="space-y-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <QuestionAction
                  state={state}
                  busy={busy || uploads > 0 || electorateLoading}
                  onClick={() =>
                    void save(undefined, state === 'open' ? 'closed' : 'open')
                  }
                />
                {state === 'scheduled' && (
                  <Button
                    variant="secondary"
                    disabled={busy || dirty}
                    onClick={() => void cancelStart()}
                  >
                    {t('Отменить запуск')}
                  </Button>
                )}
                {saved && saved.state !== 'draft' && (
                  <Button
                    variant="secondary"
                    startIcon={<FilePenLine />}
                    disabled={busy || dirty}
                    onClick={() => setMakeDraft(true)}
                  >
                    {t('Сделать черновиком')}
                  </Button>
                )}
              </div>
            </div>
            <CheckboxField
              id={`${prefix}-auto-complete`}
              label={t('Закрыть, когда ответят все выбранные участники')}
              checked={value.closeWhenAllAnswered ?? false}
              disabled={busy || state === 'open' || state === 'scheduled'}
              onChange={(event) =>
                field('closeWhenAllAnswered', event.target.checked)
              }
            />
            {value.closeWhenAllAnswered && (
              <ExpectedLinks
                roomId={roomId}
                selected={value.expectedLinkIds ?? []}
                disabled={busy || state === 'open' || state === 'scheduled'}
                onChange={(ids) => field('expectedLinkIds', ids)}
                onBusy={setElectorateLoading}
                onDenied={onDenied}
              />
            )}
            {saved?.closedReason === 'all_voted' && (
              <p className="text-sm text-muted">
                {t('Все выбранные участники ответили')}
              </p>
            )}
            {saved?.expectedTotal !== undefined && saved.expectedTotal > 0 && (
              <p className="text-sm text-muted">
                {t('Ответили по выбранным ссылкам:')}
                {saved.expectedAnswered}
                {t(' из')} {saved.expectedTotal}
              </p>
            )}
            <CheckboxField
              id={`${prefix}-scheduled`}
              label={t('Отложенный старт')}
              checked={start.deadlineMode !== 'none'}
              disabled={busy}
              onChange={(event) =>
                setStart((old) => ({
                  ...old,
                  deadlineMode: event.target.checked ? 'duration' : 'none',
                }))
              }
            />
            {start.deadlineMode !== 'none' && (
              <QuestionDeadline
                purpose="start"
                value={start}
                onChange={setStart}
                timeZone={timeZone}
                disabled={busy}
                at={saved?.scheduledAt}
              />
            )}
            <QuestionDeadline
              value={deadline}
              onChange={setDeadline}
              timeZone={timeZone}
              disabled={busy}
              at={
                saved?.state === 'open'
                  ? saved.closesAt
                  : saved?.state === 'scheduled'
                    ? saved.deadlineMode === 'duration' &&
                      saved.scheduledAt &&
                      saved.closeAfterSeconds
                      ? new Date(
                          Date.parse(saved.scheduledAt) +
                            saved.closeAfterSeconds * 1000,
                        ).toISOString()
                      : saved.closesAt
                    : null
              }
            />
            {saved?.editLocked !== null && saved && (
              <p className="text-xs text-muted">
                {t('При повторном открытии прежние голоса сохраняются')}
              </p>
            )}
          </TabPanel>
        </TabPanels>
        {error && (
          <p role="alert" className="text-sm text-error-ink">
            {t(error)}
          </p>
        )}
        {conflict && (
          <Button variant="secondary" onClick={onReload}>
            {t('Загрузить актуальную версию')}
          </Button>
        )}
        {locked && (
          <p className="text-xs text-muted">
            {t('Администратор не может редактировать содержимое этого вопроса')}
          </p>
        )}
      </Form>
      {section === 'management' && saved?.state === 'open' && !dirty && (
        <ManualVoting
          roomId={roomId}
          questionId={saved.id}
          onDenied={onDenied}
          timeZone={timeZone}
        />
      )}
      {reopen && (
        <ConfirmDialog
          title={t('Открыть вопрос повторно?')}
          description={t(
            'Результаты снова будут скрыты до окончания Уже увиденные и скачанные итоги отозвать нельзя',
          )}
          confirmLabel={t('Открыть вопрос')}
          busy={busy}
          error={t(error)}
          onClose={() => setReopen(false)}
          onConfirm={() => void save(undefined, 'open')}
        />
      )}
      {makeDraft && (
        <ConfirmDialog
          title={t('Сделать вопрос черновиком?')}
          description={t(
            'Все ответы будут удалены, вопрос будет скрыт от респондентов',
          )}
          confirmLabel={t('Сделать черновиком')}
          busy={busy}
          error={t(error)}
          onConfirm={() => void resetAnswers()}
          onClose={() => setMakeDraft(false)}
        />
      )}
      {discard && (
        <ConfirmDialog
          title={t('Отменить изменения?')}
          description={t(
            'Несохраненные изменения во всех разделах вопроса будут потеряны',
          )}
          confirmLabel={t('Отменить изменения')}
          cancelLabel={t('Продолжить редактирование')}
          busy={false}
          onClose={() => setDiscard(false)}
          onConfirm={reset}
        />
      )}
    </Panel>
  );
}
