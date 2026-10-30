'use client';
import Link from 'next/link';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Code2,
  FileSpreadsheet,
  Fingerprint,
  Globe,
  Link2,
  LockKeyhole,
  Moon,
  MousePointer2,
  QrCode,
  Radio,
  ShieldCheck,
  Users,
  Volume2,
  WandSparkles,
} from 'lucide-react';
import {GithubMark} from '../../components/github-mark';
import QRCode from 'qrcode';
import {PageHeader} from '../../components/page-header';
import {HeroBrand} from '../../components/hero-brand';
import {SoundScope} from '../../components/sound-scope';
import {HeroBackground} from '../../components/hero-background';
import {useI18n} from '../../components/language-provider';
import {
  DemoAdmin,
  DemoDevices,
  DemoProjector,
  demoChoices,
  type DemoOptions,
} from './demo';
import styles from './landing.module.css';
import {QrSparks} from './qr-sparks';
import {ProjectorStage} from './projector-stage';

// Keep example votes stable across server rendering and hydration
const baseline = [18, 12, 7];
const repository = 'https://github.com/mvodya/vote-machine';

// Reuse the same quiet section marker throughout the story
function Marker({children}: {children: ReactNode}) {
  return (
    <p className="mb-5 text-xs font-medium tracking-[0.16em] uppercase text-muted">
      {children}
    </p>
  );
}

// Share navigation styling without nesting links inside buttons
function ActionLink({
  href = '/',
  children,
  secondary = false,
}: {
  href?: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <Link
      href={href}
      onClick={(event) => {
        if (!href.startsWith('#')) return;
        event.preventDefault();
        document.querySelector(href)?.scrollIntoView({
          behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'instant'
            : 'smooth',
        });
        history.replaceState(null, '', href);
      }}
      className={`inline-flex min-h-12 items-center justify-center gap-3 rounded-full border px-6 py-3 text-sm font-medium motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink ${secondary ? 'border-border bg-panel/60 text-ink hover:bg-accent' : 'border-primary bg-primary text-on-primary hover:bg-primary/90'}`}
    >
      {children}
      <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
    </Link>
  );
}

// Generate a real QR image for navigation within this local demonstration
function DemoQr() {
  const {t} = useI18n();
  const [image, setImage] = useState('');
  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(`${location.origin}/about#devices`, {
      width: 224,
      margin: 2,
      color: {dark: '#142d26', light: '#ffffff'},
    })
      .then((value) => {
        if (active) setImage(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="mx-auto grid size-40 place-items-center rounded-2xl bg-white p-2 shadow-xl sm:size-48">
      {image /* The QR library creates an image, no remote media is requested */ ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={image}
          width={224}
          height={224}
          alt={t('QR Code')}
          className="h-full w-full rounded-lg"
        />
      ) : (
        <QrCode className="size-20 text-slate-800" aria-hidden="true" />
      )}
    </div>
  );
}

// Tell the product story using local state and the real interface controls
export function Landing() {
  const {t} = useI18n();
  const root = useRef<HTMLElement>(null);
  const [votes, setVotes] = useState<(number | null)[]>([null, null]);
  const total =
    baseline.reduce((sum, count) => sum + count, 0) +
    votes.filter((vote) => vote !== null).length;
  const options: DemoOptions = demoChoices.map((choice, index) => {
    const count =
      baseline[index] + votes.filter((vote) => vote === index).length;
    return {
      id: `00000000-0000-4000-8000-00000000001${index}`,
      content: t(choice),
      count,
      percent: Math.round((count / total) * 1000) / 10,
    };
  });
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const scenes = [...element.querySelectorAll<HTMLElement>('[data-scene]')];
    // Move decorative layers only, leaving the controls still and clickable
    function paint() {
      frame = 0;
      if (motion.matches) return;
      for (const scene of scenes) {
        const bounds = scene.getBoundingClientRect();
        if (bounds.bottom < 0 || bounds.top > innerHeight) continue;
        const progress = Math.max(
          -1,
          Math.min(
            1,
            (innerHeight / 2 - (bounds.top + bounds.height / 2)) / innerHeight,
          ),
        );
        scene.style.setProperty('--drift', `${progress * 75}px`);
        scene.style.setProperty('--tilt', `${progress * 5}deg`);
      }
    }
    function scroll() {
      if (!frame) frame = requestAnimationFrame(paint);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-visible', 'true');
            observer.unobserve(entry.target);
          }
      },
      {threshold: 0.12},
    );
    element
      .querySelectorAll('[data-reveal]')
      .forEach((node) => observer.observe(node));
    window.addEventListener('scroll', scroll, {passive: true});
    window.addEventListener('resize', scroll);
    motion.addEventListener('change', scroll);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', scroll);
      window.removeEventListener('resize', scroll);
      motion.removeEventListener('change', scroll);
    };
  }, []);
  // Replace one device answer rather than adding duplicate demo votes
  function vote(device: number, choice: number) {
    setVotes((current) =>
      current.map((value, index) => (index === device ? choice : value)),
    );
  }
  const features = [
    {
      icon: ShieldCheck,
      title: 'Анонимные ответы',
      text: 'Скройте связь между участником и его выбором',
    },
    {
      icon: LockKeyhole,
      title: 'Результаты после закрытия',
      text: 'При необходимости скрывайте итоги даже от администратора до конца голосования',
    },
    {
      icon: Radio,
      title: 'Все в реальном времени',
      text: 'Ответы, результаты и изменения вопросов появляются без перезагрузки',
    },
    {
      icon: WandSparkles,
      title: 'Markdown и медиа',
      text: 'Добавляйте изображения, анимации и видео в вопросы и варианты ответа',
    },
    {
      icon: FileSpreadsheet,
      title: 'CSV и XLSX',
      text: 'Выгружайте результаты по вопросам и участникам с учетом настроек анонимности',
    },
    {
      icon: Fingerprint,
      title: 'Без регистрации',
      text: 'Создайте комнату и сохраните административную ссылку',
    },
    {
      icon: Moon,
      title: 'Светлая и темная темы',
      text: 'Выберите акцентный цвет для всей комнаты',
    },
    {
      icon: Globe,
      title: 'Несколько языков',
      text: 'Каждый участник выбирает язык интерфейса',
    },
    {
      icon: Volume2,
      title: 'Звуковые сигналы',
      text: 'Включите звуки ответов, открытия вопросов и окончания времени',
    },
    {
      icon: MousePointer2,
      title: 'Клавиатура и телефон',
      text: 'Адаптивный интерфейс, управление с клавиатуры и поддержка уменьшения движения',
    },
    {
      icon: Users,
      title: 'Ручной ввод ответов',
      text: 'Добавляйте ответы с бумажных бюллетеней или голосуйте с общего устройства',
    },
    {
      icon: Code2,
      title: 'OPEN SOURCE',
      text: 'Изучайте код, меняйте приложение и разворачивайте на своем сервере',
    },
  ];
  return (
    <SoundScope muted>
      <main
        ref={root}
        className={`${styles.landing} overflow-clip bg-page text-ink`}
      >
        <section
          data-scene
          className="relative isolate flex min-h-svh flex-col overflow-hidden border-b border-border"
        >
          <HeroBackground />
          <PageHeader
            showBrand={false}
            className="mx-auto w-full max-w-7xl px-5 py-7 sm:px-8 lg:py-10"
          />
          <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col justify-center px-5 pt-10 pb-16 sm:px-8 lg:pt-16">
            <div className="mb-8 flex flex-wrap items-center gap-3 text-xs text-muted">
              <span className="rounded-full border border-border bg-panel/70 px-3 py-1.5">
                OPEN SOURCE
              </span>
              <span>{t('Голосования · Опросы · Кворум')}</span>
            </div>
            <HeroBrand heading />
            <div className="mt-10 flex max-w-5xl flex-col justify-between gap-8 md:flex-row md:items-end">
              <p className="max-w-lg text-xl leading-relaxed tracking-tight text-muted sm:text-2xl">
                {t(
                  'Создавайте вопросы, собирайте ответы по ссылке и показывайте результаты в реальном времени',
                )}
              </p>
              <div className="flex shrink-0 flex-wrap gap-3">
                <ActionLink>{t('Создать комнату')}</ActionLink>
                <ActionLink href="#devices" secondary>
                  {t('Попробовать здесь')}
                </ActionLink>
              </div>
            </div>
            <div className="mt-14 flex items-center justify-between border-t border-border/70 pt-5">
              <a
                href="#devices"
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById('devices')?.scrollIntoView({
                    behavior: matchMedia('(prefers-reduced-motion: reduce)')
                      .matches
                      ? 'instant'
                      : 'smooth',
                  });
                  history.replaceState(null, '', '#devices');
                }}
                className="inline-flex items-center gap-2 text-xs text-muted hover:text-ink"
              >
                <ArrowDown className={`size-4 ${styles.scrollArrow}`} />
                {t('Посмотрите, как это работает')}
              </a>
            </div>
          </div>
        </section>

        <section
          id="devices"
          data-scene
          className="relative mx-auto max-w-7xl scroll-mt-8 px-5 py-20 sm:px-8 sm:py-28"
        >
          <div data-reveal className={styles.reveal}>
            <Marker>{t('Ответы с любого устройства')}</Marker>
            <div className="grid gap-6 md:grid-cols-2">
              <h2 className="max-w-lg text-4xl leading-tight font-medium tracking-tight sm:text-5xl">
                {t('Один вопрос')}
                <br />
                {t('Независимые ответы')}
              </h2>
              <p className="max-w-md text-lg leading-relaxed text-muted md:justify-self-end">
                {t(
                  'Участники отвечают по ссылке с телефона или компьютера - без установки приложения и регистрации',
                )}
              </p>
            </div>
          </div>
          <div className="relative isolate mt-14">
            <div className={styles.deviceHalo} aria-hidden="true" />
            <DemoDevices votes={votes} onVote={vote} />
          </div>
        </section>

        <section
          data-scene
          className={`${styles.projectionScene} relative isolate overflow-hidden border-y border-border bg-surface py-20 sm:py-28`}
        >
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <div data-reveal className={styles.reveal}>
              <Marker>{t('Результат для всей аудитории')}</Marker>
              <h2 className="max-w-2xl text-4xl leading-tight font-medium tracking-tight sm:text-5xl">
                {t('На большом экране')}
                <br />
                {t('Результаты для всех')}
              </h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-muted">
                {t(
                  'Выведите результаты на проектор во время встречи, занятия или заседания совета - новые ответы появятся на экране автоматически',
                )}
              </p>
            </div>
            <ProjectorStage>
              <DemoProjector />
            </ProjectorStage>
          </div>
        </section>

        <section
          data-scene
          className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-24 sm:px-8 lg:grid-cols-[0.8fr_1.5fr] lg:gap-16 lg:py-36"
        >
          <div data-reveal className={styles.reveal}>
            <Marker>{t('Управление в одной комнате')}</Marker>
            <h2 className="text-4xl leading-tight font-medium tracking-tight sm:text-5xl">
              {t('Вопросы')}
              <br />
              {t('Респонденты')}
              <br />
              {t('Результаты')}
            </h2>
            <p className="mt-6 text-lg leading-relaxed text-muted">
              {t(
                'Подготовьте вопросы, выдайте ссылки и управляйте ходом голосования - все по одной административной ссылке',
              )}
            </p>
          </div>
          <div className="min-w-0">
            <DemoAdmin options={options} total={total} />
          </div>
        </section>

        <section
          data-scene
          className="border-y border-border bg-surface px-5 py-24 sm:px-8"
        >
          <div className="mx-auto max-w-7xl">
            <div data-reveal className={styles.reveal}>
              <Marker>{t('Два способа пригласить участников')}</Marker>
              <h2 className="max-w-2xl text-4xl leading-tight font-medium tracking-tight sm:text-5xl">
                {t('Личная ссылка или один QR для всех')}
              </h2>
            </div>
            <div className="mt-14 grid gap-6 md:grid-cols-2">
              <article
                data-reveal
                className={`${styles.reveal} rounded-3xl border border-border bg-page p-6 sm:p-10`}
              >
                <Link2 className="mb-5 size-7 text-primary" />
                <h3 className="text-2xl font-medium">
                  {t('Каждому своя ссылка')}
                </h3>
                <p className="mt-4 max-w-sm leading-relaxed text-muted">
                  {t(
                    'Назначьте имя и отправьте персональную ссылку - право голоса сохраняется при смене устройства',
                  )}
                </p>
                <div className="mt-10 space-y-3">
                  {['Александра', 'Михаил', 'София'].map((name, index) => (
                    <div
                      key={name}
                      className={`${styles.invitation} flex items-center gap-3 rounded-2xl border border-border bg-panel p-4`}
                      style={{animationDelay: `${index * -1.5}s`}}
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent">
                        <Users className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{t(name)}</p>
                        <p className="truncate font-mono text-[11px] text-muted">
                          vote / {['a7f2', 'b8e3', 'c9d4'][index]}••••
                        </p>
                      </div>
                      <Check className="size-4 shrink-0 text-success-ink" />
                    </div>
                  ))}
                </div>
              </article>
              <article
                data-reveal
                className={`${styles.reveal} relative overflow-hidden rounded-3xl border border-border bg-accent/30 p-6 sm:p-10`}
              >
                <QrCode className="mb-5 size-7 text-primary" />
                <h3 className="text-2xl font-medium">
                  {t('Одна ссылка для аудитории')}
                </h3>
                <p className="mt-4 max-w-sm leading-relaxed text-muted">
                  {t(
                    'Покажите QR-код на экране или передайте общее устройство - каждый участник отвечает в своем прохождении',
                  )}
                </p>
                <div className="relative mt-10 rounded-2xl border border-border bg-panel p-6">
                  <DemoQr />
                  <QrSparks />
                  <div
                    className={`${styles.scanLine} pointer-events-none absolute inset-x-10 top-1/2 h-px bg-red-500 shadow-[0_0_15px_#ef4444]`}
                    aria-hidden="true"
                  />
                </div>
                <div
                  className="mt-5 flex justify-center gap-4 text-primary"
                  aria-hidden="true"
                >
                  {Array.from({length: 5}, (_, index) => (
                    <span
                      key={index}
                      className={`${styles.audience} grid size-9 place-items-center rounded-full border border-border bg-panel`}
                      style={{animationDelay: `${index * -0.8}s`}}
                    >
                      <Users className="size-4" />
                    </span>
                  ))}
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32">
          <div data-reveal className={styles.reveal}>
            <Marker>{t('Настройте под свое голосование')}</Marker>
            <h2 className="max-w-xl text-4xl leading-tight font-medium tracking-tight sm:text-5xl">
              {t('От короткого опроса до заседания совета')}
            </h2>
          </div>
          <div className="mt-14 grid gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {features.map(({icon: Icon, title, text}, index) => (
              <article
                key={title}
                data-reveal
                className={styles.reveal}
                style={{'--delay': `${(index % 3) * 70}ms`} as CSSProperties}
              >
                <span className="mb-5 inline-flex size-11 items-center justify-center rounded-2xl border border-border bg-panel text-primary">
                  <Icon className="size-5" />
                </span>
                <h3 className="text-lg font-semibold">{t(title)}</h3>
                <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">
                  {t(text)}
                </p>
              </article>
            ))}
          </div>
        </section>

        <section
          data-scene
          className="relative isolate overflow-hidden border-t border-border px-5 pt-24 pb-16 sm:px-8 sm:pt-32"
        >
          <div className={styles.endGlow} aria-hidden="true" />
          <div className="mx-auto max-w-7xl">
            <Code2 className="mb-6 size-8 text-primary" />
            <p className="text-xs tracking-[0.16em] text-muted uppercase">
              OPEN SOURCE
            </p>
            <h2 className="mt-6 max-w-3xl text-4xl leading-tight font-medium tracking-tight sm:text-6xl">
              {t('Создайте комнату и задайте первый вопрос')}
            </h2>
            <div className="mt-10 flex flex-wrap gap-4">
              <ActionLink>{t('Перейти к созданию комнаты')}</ActionLink>
              <a
                href={repository}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-12 items-center gap-3 rounded-full border border-border bg-panel/60 px-6 py-3 text-sm hover:bg-accent"
              >
                <GithubMark />
                GitHub
                <ArrowUpRight className="size-4" />
              </a>
            </div>
            <p className="mt-8 max-w-lg text-sm leading-relaxed text-muted">
              {t(
                'Код открыт по лицензии MIT - приложение можно развернуть на своем сервере',
              )}
            </p>
            <div className="mt-16 flex flex-wrap items-center justify-between gap-4 border-t border-border pt-6 text-xs text-muted">
              <span>Vote Machine</span>
              <a
                href={repository}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 hover:text-ink"
              >
                <GithubMark />
                mvodya / vote-machine
                <ArrowUpRight className="size-3" />
              </a>
            </div>
          </div>
        </section>
      </main>
    </SoundScope>
  );
}
