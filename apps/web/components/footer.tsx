'use client';
import {useI18n} from './language-provider';
import {
  CalendarClock,
  GitCommitHorizontal,
  Globe,
  UserRound,
} from 'lucide-react';
import {GithubMark} from './github-mark';
import {Popover} from './ui/popover';
// Keep the footer small and show build details only on request
export function Footer() {
  const {t} = useI18n();
  return (
    <footer className="absolute inset-x-5 bottom-2 text-right text-[10px] leading-4 font-normal text-muted/45 sm:inset-x-8 lg:inset-x-12">
      <Popover
        label={t('О приложении')}
        side="top"
        className="py-1"
        trigger={
          <>
            Vote Machine ·{' '}
            <span className="ml-1 font-mono">
              {process.env.NEXT_PUBLIC_GIT_COMMIT}
            </span>
          </>
        }
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold">Vote Machine</h2>
          <a
            href="https://github.com/mvodya/vote-machine"
            aria-label="GitHub"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md p-1 text-muted hover:text-ink"
          >
            <GithubMark />
          </a>
        </div>
        <dl className="space-y-2">
          <div>
            <dt className="flex items-center gap-2 text-muted">
              <GitCommitHorizontal aria-hidden="true" className="size-4" />
              {t('Версия')}
            </dt>
            <dd className="font-mono">{process.env.NEXT_PUBLIC_GIT_COMMIT}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-2 text-muted">
              <CalendarClock aria-hidden="true" className="size-4" />
              {t('Сборка frontend, UTC')}
            </dt>
            <dd>
              <time dateTime={process.env.NEXT_PUBLIC_BUILD_TIME}>
                {process.env.NEXT_PUBLIC_BUILD_TIME}
              </time>
            </dd>
          </div>
        </dl>
        <div className="mt-3 space-y-1 border-t border-border pt-3">
          <p className="flex items-center gap-2">
            <UserRound
              aria-hidden="true"
              className="size-4 shrink-0 text-muted"
            />
            Mark Vodyanitskiy
          </p>
          <p className="flex items-center gap-2">
            <Globe aria-hidden="true" className="size-4 shrink-0 text-muted" />
            <a
              className="underline"
              href="https://mvodya.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              mvodya.com
            </a>
          </p>
        </div>
      </Popover>
    </footer>
  );
}
