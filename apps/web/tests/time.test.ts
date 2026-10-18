import {expect, it} from 'vitest';
import {
  wallTime,
  wallTimeToInstant,
  validTimeZone,
  formatTime,
} from '../lib/time';

it('uses a shared zone across date boundaries and fixed-offset areas', () => {
  expect(wallTime('2026-10-25T20:30:15Z', 'Asia/Vladivostok')).toBe(
    '2026-10-26T06:30:15',
  );
  expect(wallTimeToInstant('2026-10-26T06:30:15', 'Asia/Vladivostok')).toBe(
    '2026-10-25T20:30:15.000Z',
  );
  expect(wallTimeToInstant('2026-10-26T06:30', 'Asia/Kathmandu')).toBe(
    '2026-10-26T00:45:00.000Z',
  );
  expect(formatTime('2026-10-25T20:30:15Z', 'Asia/Vladivostok')).toContain(
    '26.10.2026',
  );
});
it('rejects missing and duplicate wall times around daylight-saving changes', () => {
  expect(() => wallTimeToInstant('2026-03-29T02:30', 'Europe/Berlin')).toThrow(
    'не существует',
  );
  expect(() => wallTimeToInstant('2026-10-25T02:30', 'Europe/Berlin')).toThrow(
    'встречается дважды',
  );
  expect(() => wallTimeToInstant('2026-02-30T12:00', 'Europe/Berlin')).toThrow(
    'Некорректная дата',
  );
  expect(validTimeZone('unknown/zone')).toBe(false);
});
