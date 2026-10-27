// Show the supplied logo and app name
export function Brand({className = ''}: {className?: string}) {
  return (
    <div
      className={`flex items-center gap-2 text-lg sm:gap-3 sm:text-2xl font-semibold tracking-tight text-ink ${className}`}
    >
      {/* The owner supplied this logo as a static SVG asset */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/brand/votebox-icon.svg"
        alt=""
        width={40}
        height={40}
        className="size-8 shrink-0 sm:size-10"
      />
      votemachine
    </div>
  );
}
