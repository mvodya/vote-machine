import {expect, it, vi} from 'vitest';
// Keep actual audio out of unit tests, browser files have separate checks
it('keeps audio off by default and never replays a repeated or muted event', async () => {
  vi.resetModules();
  const instances: {
    src: string;
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
  }[] = [];
  class Player {
    play = vi.fn(() => Promise.resolve());
    pause = vi.fn();
    currentTime = 0;
    volume = 1;
    constructor(public src: string) {
      instances.push(this);
    }
  }
  vi.stubGlobal('Audio', Player);
  const {playSound, setSoundEnabled} = await import('../lib/audio');
  playSound('open', 'muted');
  expect(instances).toHaveLength(0);
  setSoundEnabled(true, true);
  expect(instances).toHaveLength(6);
  const open = instances.find((item) => item.src.endsWith('/open.wav'))!;
  expect(open.play).toHaveBeenCalledTimes(1);
  playSound('open', 'muted');
  expect(open.play).toHaveBeenCalledTimes(1);
  playSound('open', 'new');
  playSound('open', 'new');
  expect(open.play).toHaveBeenCalledTimes(2);
  setSoundEnabled(false);
  expect(open.pause).toHaveBeenCalled();
  playSound('answer', 'late');
  expect(
    instances.find((item) => item.src.endsWith('/answer.wav'))!.play,
  ).not.toHaveBeenCalled();
});
