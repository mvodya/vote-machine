import {act, render, screen} from '@testing-library/react';
import {expect, it, vi} from 'vitest';
import {Countdown, countdownText} from '../components/countdown';
it('turns red at a minute and pulses only during the last ten seconds', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'));
  try {
    render(<Countdown at="2026-10-26T00:01:01Z" timeZone="UTC" />);
    const timer = screen.getByRole('timer');
    expect(timer).not.toHaveClass('text-error-ink');
    act(() => vi.advanceTimersByTime(1000));
    expect(timer).toHaveClass('text-error-ink');
    expect(timer).not.toHaveClass('motion-safe:animate-pulse');
    act(() => vi.advanceTimersByTime(50000));
    expect(timer).toHaveClass('motion-safe:animate-pulse');
    act(() => vi.advanceTimersByTime(10000));
    expect(timer).toHaveTextContent('00:00:00');
    expect(timer).not.toHaveClass('motion-safe:animate-pulse');
  } finally {
    vi.useRealTimers();
  }
});
it('formats long and elapsed durations without negative time', () => {
  expect(countdownText(90061)).toBe('1 д 01:01:01');
  expect(countdownText(-1)).toBe('00:00:00');
});
