import RoomEntry from './room-entry';
import {Brand} from '../components/brand';

// Show the home layout for desktop and phone screens
export default function Home() {
  return (
    <main className="min-h-svh bg-surface text-ink lg:grid lg:grid-cols-[3fr_2fr]">
      <aside
        className="relative hidden min-h-svh overflow-hidden bg-accent p-12 lg:block"
        aria-label="О votemachine"
      >
        <Brand className="relative z-10" />
        <div
          className="absolute inset-0 grid place-items-center"
          aria-hidden="true"
        >
          <div className="absolute aspect-square w-[70%] max-w-135 rounded-full border border-ink/10" />
          <div className="absolute aspect-square w-[91%] max-w-178 rounded-full border border-dashed border-ink/10" />
          <div className="relative text-[150px] font-semibold leading-none">
            V
          </div>
        </div>
      </aside>
      <section
        className="flex min-h-svh min-w-0 flex-col px-5 py-7 sm:px-8 lg:justify-center lg:px-[clamp(2rem,4vw,4.75rem)] lg:py-12"
        aria-label="Создание комнаты и вход"
      >
        <header className="mobile-brand lg:hidden">
          <Brand />
        </header>
        <RoomEntry />
      </section>
    </main>
  );
}
