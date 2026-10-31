// Keep the app name and hero type style the same on every surface
export function Wordmark({
  muted = false,
}: {
  // Footers use a quiet gray name instead of the brand colors
  muted?: boolean;
}) {
  return (
    <span
      data-wordmark
      className={`whitespace-nowrap font-semibold tracking-[-0.085em] ${muted ? 'text-muted' : ''}`}
    >
      <span className={muted ? 'text-inherit' : 'text-ink'}>vote.</span>
      <span className={`font-light ${muted ? 'text-inherit' : 'text-primary'}`}>
        machine.
      </span>
    </span>
  );
}
