'use client';
import {useI18n} from './language-provider';
import Link from 'next/link';
import {Brand} from './brand';
import {Preferences} from './preferences';
// Keep branding and personal controls aligned on every page
export function PageHeader({
  home = false,
  showBrand = true,
  className = '',
}: {
  // Public hero pages already show a large logo
  showBrand?: boolean;
  // The home page does not need a link to itself
  home?: boolean;
  // Page-specific width and spacing
  className?: string;
}) {
  const {t} = useI18n();
  return (
    <header
      className={`@container flex items-center gap-3 ${showBrand ? 'justify-between' : 'justify-end'} ${className}`}
    >
      {showBrand &&
        (home ? (
          <Brand />
        ) : (
          <Link
            href="/"
            aria-label={`vote.machine. - ${t('На главную')}`}
            className="rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
          >
            <Brand />
          </Link>
        ))}
      <Preferences />
    </header>
  );
}
