// Keep build details quiet and consistent on every page
export function Footer() {
  return (
    <footer className="absolute inset-x-5 bottom-2 text-right text-[10px] leading-4 font-normal text-muted/45 sm:inset-x-8 lg:inset-x-12">
      {new Date().getFullYear()} · Vote Machine ·{' '}
      <span className="font-mono">{process.env.NEXT_PUBLIC_GIT_COMMIT}</span>
    </footer>
  );
}
