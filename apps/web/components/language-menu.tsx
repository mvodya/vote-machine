'use client';
import {Check, Globe} from 'lucide-react';
import {useI18n} from './language-provider';
import {Popover} from './ui/popover';
import {Button} from './ui/button';
import {languages, locales} from '../lib/i18n/translate';

// Show each language in its own name so switching back is always possible
export function LanguageMenu() {
  const {locale, setLocale, t} = useI18n();
  return (
    <Popover
      label={t('Язык интерфейса')}
      className="size-10 text-muted hover:bg-ink/5 hover:text-ink"
      trigger={<Globe aria-hidden="true" className="size-4 shrink-0" />}
    >
      <h2 className="mb-3 text-sm font-semibold">{t('Язык интерфейса')}</h2>
      <div className="space-y-1">
        {locales.map((value) => (
          <Button
            key={value}
            variant="ghost"
            fullWidth
            aria-pressed={locale === value}
            lang={value}
            data-popover-close
            onClick={() => setLocale(value)}
          >
            <span className="inline-flex items-center gap-3">
              <span className="text-xl" aria-hidden="true">
                {languages[value].flag}
              </span>
              {languages[value].name}
            </span>
            {locale === value && <Check aria-hidden="true" />}
          </Button>
        ))}
      </div>
    </Popover>
  );
}
