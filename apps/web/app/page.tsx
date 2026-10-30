'use client';
import Link from 'next/link';
import {ArrowUpRight} from 'lucide-react';
import {useI18n} from '../components/language-provider';
import RoomEntry from './room-entry';
import {PageHeader} from '../components/page-header';
import {HeroBrand} from '../components/hero-brand';
import {HeroBackground} from '../components/hero-background';
import {HomeCaption} from '../components/home-caption';
// Align the public details with the room action selector
export default function Home() {
  const {t} = useI18n();
  return (
    <main className="relative isolate min-h-svh overflow-clip bg-page text-ink">
      <HeroBackground />
      <PageHeader
        home
        showBrand={false}
        className="absolute inset-x-0 top-0 z-10 px-5 py-7 sm:px-8 lg:p-12"
      />
      <div className="relative flex min-h-svh flex-col justify-center pt-28 pb-14 lg:pt-36">
        <div className="relative grid items-start lg:grid-cols-[3fr_2fr]">
          <div className="contents lg:block lg:min-w-0 lg:pt-8">
            <div className="order-1 min-w-0 px-7 pb-8 sm:px-10 lg:px-12">
              <HeroBrand />
            </div>
            <aside
              className="order-3 px-7 pt-3 pb-7 sm:px-10 lg:order-1 lg:px-12 lg:pt-0 lg:pb-8"
              aria-label={t('О votemachine')}
            >
              <HomeCaption />
              <Link
                href="/about"
                className="mt-6 inline-flex min-h-12 items-center gap-3 rounded-full border border-border bg-panel/70 px-5 py-3 text-sm font-medium text-ink backdrop-blur-sm transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ink motion-reduce:transition-none"
              >
                {t('Подробнее о Vote Machine')}
                <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
              </Link>
            </aside>
          </div>
          <section
            className="order-2 min-w-0 px-5 sm:px-8 lg:order-2 lg:px-[clamp(2rem,4vw,4.75rem)]"
            aria-label={t('Создание комнаты и вход')}
          >
            <div className="rounded-3xl border border-border/60 bg-surface/75 px-5 backdrop-blur-md sm:px-7 lg:border-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
              <RoomEntry />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
