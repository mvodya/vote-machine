// Read the browser zone without storing a device-specific override
export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
// Validate an IANA zone before using it in browser controls
export function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat('ru-RU', {timeZone: value});
    return true;
  } catch {
    return false;
  }
}
// Format an instant in the shared room zone
export function formatTime(
  value: string,
  zone = localTimeZone(),
  locale = 'ru-RU',
) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date(value));
}
// Read a wall-clock value without losing its calendar date
export function wallTime(value: string, zone = localTimeZone()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (name: string) =>
    parts.find((item) => item.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
// Find valid offsets around a date, including daylight-saving changes
export function wallTimeToInstant(value: string, zone: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error('Укажите дату и время');
  const normalized = value.length === 16 ? `${value}:00` : value;
  const naive = Date.parse(`${normalized}Z`);
  if (
    !Number.isFinite(naive) ||
    new Date(naive).toISOString().slice(0, 19) !== normalized
  )
    throw new Error('Некорректная дата');
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = naive + hours * 3600000;
    offsets.add(
      Date.parse(`${wallTime(new Date(sample).toISOString(), zone)}Z`) - sample,
    );
  }
  const matches = [...offsets]
    .map((offset) => naive - offset)
    .filter(
      (instant) =>
        wallTime(new Date(instant).toISOString(), zone) === normalized,
    )
    .sort((a, b) => a - b);
  if (matches.length === 0)
    throw new Error('Это местное время не существует из-за перевода часов');
  if (matches.length > 1)
    throw new Error(
      'Это время встречается дважды при переводе часов, выберите другое время',
    );
  return new Date(matches[0]).toISOString();
}
