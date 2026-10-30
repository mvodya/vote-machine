'use client';
import {useI18n} from '../components/language-provider';
import Link from 'next/link';
import {RotateCcw} from 'lucide-react';
import {PageHeader} from '../components/page-header';
import {Button} from '../components/ui/button';
// Offer a safe retry without exposing internal error details
export default function PageError({
  reset,
}: {
  // Retry rendering the failed page
  reset: () => void;
}) {
  const {t} = useI18n();
  return (
    <main className="mx-auto min-h-svh max-w-6xl px-5 pb-12 sm:px-8">
      <PageHeader className="py-7" />
      <div className="py-16">
        <h1 className="text-2xl font-semibold">
          {t('Не удалось загрузить страницу')}
        </h1>
        <p role="alert" className="mt-4 text-sm text-muted">
          {t('Попробуйте снова')}
        </p>
        <div className="mt-6 flex items-center gap-5">
          <Button startIcon={<RotateCcw />} onClick={reset}>
            {t('Попробовать снова')}
          </Button>
          <Link
            href="/"
            className="rounded-lg text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
          >
            {t('На главную')}
          </Link>
        </div>
      </div>
    </main>
  );
}
