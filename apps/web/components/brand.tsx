// Show the temporary V mark and app name
export function Brand({className = ''}: {className?: string}) {
  return (
    <div
      className={`flex items-center gap-3 text-2xl font-semibold tracking-tight text-ink ${className}`}
    >
      <span
        className="inline-flex size-8 shrink-0 items-center justify-center text-[26px] font-bold leading-none"
        aria-hidden="true"
      >
        V
      </span>
      votemachine
    </div>
  );
}
