import RoomEntry from './room-entry';
import {PageHeader} from '../components/page-header';
import {DotWaves} from '../components/dot-waves';
import {IconRibbons} from '../components/icon-ribbons';
import {HomeCaption} from '../components/home-caption';

// Show the home layout for desktop and phone screens
export default function Home() {
  return (
    <main className="relative min-h-svh bg-surface text-ink lg:grid lg:grid-cols-[3fr_2fr]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden lg:[mask-image:linear-gradient(to_right,black_35%,rgb(0_0_0/0.12)_100%)]"
      >
        <DotWaves />
        <IconRibbons />
      </div>
      <PageHeader
        home
        className="absolute inset-x-0 top-0 z-10 px-5 py-7 sm:px-8 lg:p-12"
      />
      <aside className="hidden min-h-svh lg:block" aria-label="О votemachine" />
      <section
        className="relative flex min-h-[calc(100svh-8rem)] min-w-0 flex-col px-5 pt-28 pb-7 sm:px-8 lg:min-h-svh lg:justify-center lg:px-[clamp(2rem,4vw,4.75rem)] lg:pt-40 lg:pb-12"
        aria-label="Создание комнаты и вход"
      >
        <div className="my-auto rounded-3xl border border-border/60 bg-surface/75 px-5 backdrop-blur-md sm:px-7 lg:border-0 lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
          <RoomEntry />
        </div>
      </section>
      <HomeCaption />
    </main>
  );
}
