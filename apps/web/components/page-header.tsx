'use client';
import {useI18n} from './language-provider';
import Link from 'next/link';
import {Brand} from './brand';
import {Preferences} from './preferences';
// Keep branding and personal controls aligned on every page
export function PageHeader({
  home = false,
  className = '',
}: {
  // The home page does not need a link to itself
  home?: boolean;
  // Page-specific width and spacing
  className?: string;
}) {
  const {t} = useI18n();
  return (
    <header className={`flex items-center justify-between gap-3 ${className}`}>
      {home ? (
        <Brand />
      ) : (
        <Link
          href="/"
          aria-label={t('На главную')}
          className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
        >
          <Brand />
        </Link>
      )}
      <Preferences />
    </header>
  );
}
