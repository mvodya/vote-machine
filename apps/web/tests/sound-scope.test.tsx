import {act, cleanup, render} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {Countdown} from '../components/countdown';
import {SoundScope} from '../components/sound-scope';
import {playSound} from '../lib/audio';

vi.mock('../lib/audio', () => ({playSound: vi.fn()}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-15T10:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('local sound scope', () => {
  it('keeps demo minute and final-second alarms silent without muting real timers', () => {
    const at = new Date(Date.now() + 60000).toISOString();
    const view = render(
      <SoundScope muted>
        <Countdown at={at} />
      </SoundScope>,
    );
    act(() => vi.advanceTimersByTime(61000));
    expect(playSound).not.toHaveBeenCalled();
    const next = new Date(Date.now() + 60000).toISOString();
    view.rerender(
      <SoundScope muted={false}>
        <Countdown at={next} />
      </SoundScope>,
    );
    expect(playSound).toHaveBeenCalledExactlyOnceWith(
      'minute',
      expect.any(String),
    );
  });

  it('stops upcoming ticks as soon as a timer enters a muted scope', () => {
    const at = new Date(Date.now() + 12000).toISOString();
    const view = render(
      <SoundScope muted={false}>
        <Countdown at={at} />
      </SoundScope>,
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(playSound).toHaveBeenCalledExactlyOnceWith(
      'tick',
      expect.any(String),
    );
    view.rerender(
      <SoundScope muted>
        <Countdown at={at} />
      </SoundScope>,
    );
    act(() => vi.advanceTimersByTime(11000));
    expect(playSound).toHaveBeenCalledTimes(1);
  });
});
