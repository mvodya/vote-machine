import {Button} from './button';

// Use the same page controls for room lists
export function Pagination({
  label,
  page,
  hasNext,
  busy,
  onPrevious,
  onNext,
}: {
  // Name of the list for screen readers
  label: string;
  // Page number starting at one
  page: number;
  // Whether another page is available
  hasNext: boolean;
  // Block navigation while data is loading
  busy: boolean;
  // Return to the previous cursor
  onPrevious: () => void;
  // Open the next cursor
  onNext: () => void;
}) {
  // Empty and single page lists need no controls
  if (page <= 1 && !hasNext) return null;
  return (
    <nav aria-label={label} className="mt-5 flex items-center gap-3">
      <Button
        variant="secondary"
        disabled={busy || page <= 1}
        onClick={onPrevious}
      >
        Назад
      </Button>
      <span className="text-sm text-muted" aria-label={`Страница ${page}`}>
        {page}
      </span>
      <Button variant="secondary" disabled={busy || !hasNext} onClick={onNext}>
        Далее
      </Button>
    </nav>
  );
}
