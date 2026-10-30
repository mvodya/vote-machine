'use client';
import {useI18n} from '../components/language-provider';
import Link from 'next/link';
import {PageHeader} from '../components/page-header';
// Keep missing pages clear and in the same language as the app
export default function NotFound() {
  const {t} = useI18n();
  return (
    <main className="mx-auto min-h-svh max-w-6xl px-5 pb-12 sm:px-8">
      <PageHeader className="py-7" />
      <div className="py-16">
        <h1 className="text-2xl font-semibold">{t('Страница не найдена')}</h1>
        <p className="mt-4 text-sm text-muted">
          {t('Проверьте адрес страницы')}
        </p>
        <Link
          href="/"
          className="mt-6 inline-block rounded-lg text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          {t('На главную')}
        </Link>
      </div>
    </main>
  );
}
