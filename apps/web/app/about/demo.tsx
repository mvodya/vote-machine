'use client';
import {useEffect, useId, useRef, useState, type ReactNode} from 'react';
import {Monitor, Smartphone} from 'lucide-react';
import {useI18n} from '../../components/language-provider';
import {QuestionProgress} from '../../components/question-progress';
import {Panel} from '../../components/ui/panel';
import {TabPanels} from '../../components/ui/tab-panels';
import {TabPanel} from '../../components/ui/tab-panel';
import {RoomTabs, ParticipantTabs} from '../../components/workspace-tabs';
import {Results, type ResultsSnapshot} from '../../components/results';
import {Questions} from '../rooms/[id]/questions';
import {Respondents, type RespondentSnapshot} from '../rooms/[id]/respondents';
import {AnswerForm} from '../vote/[id]/answer-form';
import {emptyQuestion, type Question} from '../../lib/questions';
import {publicResult, type VoteResult} from '../../lib/results';
import {demoQuestionCycle} from './cycle';

// Only sample data belongs here, every workspace is the real component
export const demoRoom = '00000000-0000-4000-8000-000000000001';
export const demoQuestion = 'Какой формат встречи выберем?';
export const demoChoices = ['Очно', 'Онлайн', 'Гибридный'];
export type DemoOptions = NonNullable<VoteResult['options']>;
const ignore = () => {};

// Build the same question document that the answer form receives from the API
function questionDocument(t: (message: string) => string): Question {
  return {
    ...emptyQuestion(),
    id: '00000000-0000-4000-8000-000000000002',
    roomId: demoRoom,
    preview: t(demoQuestion),
    content: t(demoQuestion),
    choices: demoChoices.map((choice, index) => ({
      id: `00000000-0000-4000-8000-00000000001${index}`,
      content: t(choice),
    })),
    state: 'open',
    ordinal: '1',
    revision: '1',
    createdAt: '2026-01-15T10:00:00Z',
    editLocked: null,
    choiceCount: 3,
    allowAnswerChange: true,
    shareResults: true,
  };
}

// Scale a real workspace rather than changing its typography or button sizes
function InterfaceScale({
  width,
  children,
}: {
  width: number;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({scale: 1, height: 0});
  useEffect(() => {
    const outer = frame.current;
    const inner = content.current;
    if (!outer || !inner) return;
    function measure() {
      if (outer && inner && outer.clientWidth > 0) {
        const scale = Math.min(1, outer.clientWidth / width);
        setSize({scale, height: inner.offsetHeight * scale});
      }
    }
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    observer.observe(inner);
    measure();
    return () => observer.disconnect();
  }, [width]);
  return (
    <div
      ref={frame}
      className="relative w-full overflow-hidden"
      style={{height: size.height || undefined}}
    >
      <div
        ref={content}
        style={{
          width,
          transform: `scale(${size.scale})`,
          transformOrigin: 'top left',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// Use the actual answer form and keep each device answer independent
export function DemoBallot({
  device,
  saved,
  onVote,
}: {
  device: 'computer' | 'phone';
  saved: number | null;
  onVote: (choice: number) => void;
}) {
  const {t} = useI18n();
  const group = useId();
  const phone = device === 'phone';
  const question = questionDocument(t);
  const answer =
    saved === null
      ? null
      : {
          questionId: question.id,
          revision: '1',
          choices: [question.choices[saved].id!],
        };
  return (
    <div className="w-full" data-device={device}>
      <div className="mb-3 flex h-5 items-center gap-2 text-xs text-muted">
        {phone ? (
          <Smartphone className="size-4" />
        ) : (
          <Monitor className="size-4" />
        )}
        {t(phone ? 'Смартфон' : 'Компьютер')}
      </div>
      <div
        className={`relative border border-border bg-page shadow-2xl shadow-primary/10 ${phone ? 'min-h-[660px] rounded-[2.5rem] border-[6px] p-3 pt-11 sm:min-h-[680px]' : 'rounded-2xl border-[5px] p-4 pt-8'}`}
      >
        {phone && (
          <div
            className="absolute top-3 left-1/2 h-5 w-28 -translate-x-1/2 rounded-full bg-ink/80"
            aria-hidden="true"
          />
        )}
        {phone && (
          <div
            className="absolute bottom-2.5 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full bg-ink/70"
            aria-hidden="true"
          />
        )}
        <InterfaceScale width={phone ? 350 : 740}>
          <div
            className="bg-page p-4 pb-6 text-ink"
            role="region"
            aria-label={t(phone ? 'Смартфон' : 'Компьютер')}
          >
            <h3 className="mt-2 text-2xl font-semibold">
              {t('Встреча команды')}
            </h3>
            <p className="mt-3 text-sm text-muted">
              {t(phone ? 'Михаил' : 'Александра')} · {t('Персональная ссылка')}
            </p>
            <div className="mt-6 space-y-5">
              <div inert>
                <ParticipantTabs
                  contained
                  group={group}
                  value="question"
                  onChange={ignore}
                  resultsAvailable
                />
              </div>
              <Panel>
                <QuestionProgress
                  pending={saved === null ? 1 : 0}
                  kind="close"
                />
                <AnswerForm
                  linkId={`${demoRoom}-${device}`}
                  question={question}
                  answer={answer}
                  onSaved={ignore}
                  onRefresh={ignore}
                  onDenied={ignore}
                  onSkip={ignore}
                  onBusy={ignore}
                  onLocalAnswer={(ids) =>
                    onVote(
                      question.choices.findIndex(
                        (choice) => choice.id === ids[0],
                      ),
                    )
                  }
                />
              </Panel>
            </div>
          </div>
        </InterfaceScale>
      </div>
      {!phone && (
        <div
          className="mx-auto h-3 w-[90%] rounded-b-2xl bg-border"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

// Scale both device shells by the same ratio on desktop screens
export function DemoDevices({
  votes,
  onVote,
}: {
  // Each device keeps one independent answer
  votes: (number | null)[];
  onVote: (device: number, choice: number) => void;
}) {
  return (
    <div className="grid items-start gap-9 md:grid-cols-[minmax(0,782fr)_minmax(0,350fr)] lg:gap-20">
      <div className="hidden min-w-0 md:block">
        <InterfaceScale width={782}>
          <DemoBallot
            device="computer"
            saved={votes[0]}
            onVote={(choice) => onVote(0, choice)}
          />
        </InterfaceScale>
      </div>
      <div className="mx-auto w-full max-w-[350px] min-w-0 md:max-w-none">
        <InterfaceScale width={350}>
          <DemoBallot
            device="phone"
            saved={votes[1]}
            onVote={(choice) => onVote(1, choice)}
          />
        </InterfaceScale>
      </div>
    </div>
  );
}

// Simulate activity only while the workspace can be seen
function useExampleVotes(
  target: {current: HTMLDivElement | null},
  initial: number[],
) {
  const seed = useRef(initial);
  const [activity, setActivity] = useState(() => ({
    counts: [...initial],
    viewers: 8,
  }));
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      clearTimeout(timer);
      if (!visible || document.hidden || motion.matches) return;
      timer = setTimeout(
        () => {
          const option = Math.floor(Math.random() * seed.current.length);
          const added = 1 + Math.floor(Math.random() * 3);
          setActivity((old) => ({
            counts: old.counts.map(
              (value, index) => value + (index === option ? added : 0),
            ),
            viewers: Math.max(
              1,
              Math.min(32, old.viewers + (Math.random() > 0.45 ? 1 : -1)),
            ),
          }));
          schedule();
        },
        1000 + Math.random() * 1400,
      );
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        schedule();
      },
      {threshold: 0.2},
    );
    observer.observe(element);
    document.addEventListener('visibilitychange', schedule);
    motion.addEventListener('change', schedule);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      motion.removeEventListener('change', schedule);
    };
  }, [target]);
  return activity;
}

// Supply local data to the full results page without creating a second layout
function resultSnapshot(
  options: DemoOptions,
  total: number,
  t: (message: string) => string,
  question = questionDocument(t),
): ResultsSnapshot {
  const links = [
    {
      id: 'personal',
      name: t('Персональные ссылки'),
      mode: 'personal',
      answers: total,
      participants: total,
    },
  ];
  return {
    page: {
      questions: [
        {
          id: question.id,
          content: question.content,
          available: true,
          state: 'open',
        },
      ],
      nextCursor: null,
    },
    result: {
      id: question.id,
      roomId: demoRoom,
      available: true,
      content: question.content,
      state: 'open',
      anonymous: false,
      choiceMode: 'single',
      total,
      options,
      sources: {personal: total, reusable: 0, admin_manual: 0},
      people: [],
      nextPeopleCursor: null,
    },
    report: {
      roomName: t('Встреча команды'),
      shared: true,
      participants: total,
      answers: total,
      questions: [{id: question.id, content: question.content, answers: total}],
      sources: [{kind: 'personal', answers: total}],
      links,
      sheets: [],
      people: [],
    },
  };
}

// Show a separate live poll through the real projector view
export function DemoProjector() {
  const {t} = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const activity = useExampleVotes(viewport, [24, 17, 10]);
  const labels = ['Новые проекты', 'Обмен опытом', 'Планы команды'];
  const total = activity.counts.reduce((sum, value) => sum + value, 0);
  const question = {
    ...questionDocument(t),
    content: t('Какую тему разберем на следующей встрече?'),
  };
  const options = labels.map((label, index) => ({
    id: question.choices[index].id!,
    content: t(label),
    count: activity.counts[index],
    percent: Math.round((activity.counts[index] / total) * 1000) / 10,
  }));
  const snapshot = resultSnapshot(options, total, t, question);
  snapshot.result = publicResult(snapshot.result, true, true)!;
  return (
    <div ref={viewport} data-demo-total={total} data-demo-screen="projector">
      <InterfaceScale width={1000}>
        <div inert className="bg-page p-5">
          <Results
            id={demoRoom}
            admin
            projector
            initialQuestion={snapshot.result.id}
            snapshot={snapshot}
            onDenied={ignore}
          />
        </div>
      </InterfaceScale>
    </div>
  );
}

// Cycle the real admin workspaces while keeping their actions read-only
export function DemoAdmin({
  options,
  total,
}: {
  options: DemoOptions;
  total: number;
}) {
  const {t} = useI18n();
  const [tab, setTab] = useState('questions');
  const [paused, setPaused] = useState(false);
  const group = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const activity = useExampleVotes(viewport, [0, 0, 0]);
  const [cycle, setCycle] = useState<ReturnType<
    typeof demoQuestionCycle
  > | null>(null);
  useEffect(() => {
    const startedAt = Date.now();
    function tick() {
      const next = demoQuestionCycle(startedAt, Date.now());
      // Leave the snapshot still between phase changes
      setCycle((old) => (old?.step === next.step ? old : next));
    }
    const timer = setInterval(tick, 250);
    queueMicrotask(tick);
    return () => clearInterval(timer);
  }, []);

  const count = total + activity.counts.reduce((sum, value) => sum + value, 0);
  const liveOptions = options.map((option, index) => ({
    ...option,
    count: option.count + activity.counts[index],
    percent:
      Math.round(((option.count + activity.counts[index]) / count) * 1000) / 10,
  }));
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      {threshold: 0.25},
    );
    if (viewport.current) observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    if (!visible || paused) return;
    const timer = setInterval(() => {
      if (!document.hidden && !motion.matches)
        setTab((value) => {
          const ids = ['questions', 'respondents', 'results'];
          return ids[(ids.indexOf(value) + 1) % ids.length];
        });
    }, 5500);
    return () => clearInterval(timer);
  }, [visible, paused]);
  const question = questionDocument(t);
  const questions = [
    question,
    ...['Какие темы обсудим?', 'Оцените встречу'].map((content, index) => ({
      ...question,
      id: `draft-${index}`,
      content: t(content),
      preview: t(content),
      state: index === 0 && cycle ? cycle.state : ('draft' as const),
      startMode: index === 0 ? ('duration' as const) : ('none' as const),
      startAfterSeconds: index === 0 ? 60 : null,
      scheduledAt:
        index === 0 && cycle?.state === 'scheduled' ? cycle.endsAt : null,
      closesAt: index === 0 && cycle?.state === 'open' ? cycle.endsAt : null,
      deadlineMode: index === 0 ? ('duration' as const) : ('none' as const),
      closeAfterSeconds: index === 0 ? 60 : null,
      ordinal: `${index + 2}`,
      answerCount: 0,
      viewerCount: 0,
    })),
  ].map((value, index) => ({
    ...value,
    answerCount: index === 0 ? count : 0,
    viewerCount: index === 0 ? activity.viewers : 0,
  }));
  const respondents: RespondentSnapshot = {
    links: ['Александра', 'Михаил', 'Ссылка для аудитории'].map(
      (name, index) => ({
        id: `link-${index}`,
        name: t(name),
        mode: index === 2 ? 'reusable' : 'personal',
        ordinal: `${index + 1}`,
        revision: '1',
        revoked: false,
        sessionCount: index === 2 ? String(count) : '1',
      }),
    ),
    online: Object.fromEntries(
      [0, 1, 2].map((index) => [
        `link-${index}`,
        {
          online: index === 2 ? activity.viewers : 1,
          questions:
            index === 2 ? [] : [{id: question.id, preview: question.content}],
        },
      ]),
    ),
  };
  const snapshot = resultSnapshot(liveOptions, count, t);
  return (
    <div
      ref={viewport}
      data-admin-total={count}
      data-admin-viewers={activity.viewers}
      className="relative overflow-hidden rounded-3xl border border-border bg-page p-3 shadow-2xl shadow-primary/10"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setPaused(false);
      }}
    >
      <div
        data-admin-window
        className="h-[clamp(17rem,44vw,34rem)] overflow-hidden"
      >
        <InterfaceScale width={1100}>
          <div className="min-h-[900px] bg-page p-8 pb-10">
            <h3 className="mt-2 mb-6 text-3xl font-semibold tracking-tight">
              {t('Встреча команды')}
            </h3>
            <RoomTabs
              contained
              group={group}
              value={tab}
              onChange={setTab}
              includeSettings={false}
            />
            <TabPanels group={group} value={tab} className="pt-6">
              <TabPanel group={group} id="questions" value={tab}>
                <div inert>
                  <Questions
                    roomId={demoRoom}
                    timeZone="UTC"
                    snapshot={questions}
                    onDenied={ignore}
                  />
                </div>
              </TabPanel>
              <TabPanel group={group} id="respondents" value={tab}>
                <div inert>
                  <Respondents
                    roomId={demoRoom}
                    snapshot={respondents}
                    onDenied={ignore}
                  />
                </div>
              </TabPanel>
              <TabPanel group={group} id="results" value={tab}>
                <div inert>
                  <Results
                    id={demoRoom}
                    admin
                    initialQuestion={question.id}
                    snapshot={snapshot}
                    onDenied={ignore}
                  />
                </div>
              </TabPanel>
            </TabPanels>
          </div>
        </InterfaceScale>
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-page to-transparent"
        aria-hidden="true"
      />
    </div>
  );
}
