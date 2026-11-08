import {soundKinds} from '../lib/sounds';
import {beforeEach, expect, it, vi} from 'vitest';

// Use decoded sample stubs without a speaker or browser gesture
function audioEngine() {
  const sources: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  class Engine {
    state = 'suspended';
    destination = {};
    decodeAudioData = vi.fn(async () => ({duration: 1}));
    resume = vi.fn(async () => {
      this.state = 'running';
    });
    createGain = vi.fn(() => ({
      gain: {value: 1},
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    createBufferSource = vi.fn(() => {
      const source = {
        buffer: null,
        onended: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      sources.push(source);
      return source;
    });
  }
  const engine = new Engine();
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return engine;
    }),
  );
  const fetcher = vi.fn<
    (url: string, options?: RequestInit) => Promise<Response>
  >(async () => new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetcher);
  return {engine, sources, fetcher};
}
beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

it('downloads and decodes all sounds while muted and shares pending loads', async () => {
  const {engine, sources, fetcher} = audioEngine();
  const {prepareSounds} = await import('../lib/audio');
  await Promise.all([prepareSounds(), prepareSounds()]);
  await prepareSounds();
  expect(fetcher).toHaveBeenCalledTimes(soundKinds.length);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(
    expect.arrayContaining(['/sounds/open.mp3', '/sounds/submit.mp3']),
  );
  expect(engine.decodeAudioData).toHaveBeenCalledTimes(soundKinds.length);
  expect(engine.resume).not.toHaveBeenCalled();
  expect(sources).toHaveLength(0);
});

it('starts ready samples without fetch or decode and never replays muted events', async () => {
  const {engine, sources, fetcher} = audioEngine();
  const {prepareSounds, playSound, setSoundEnabled} =
    await import('../lib/audio');
  await prepareSounds();
  playSound('open', 'muted');
  expect(sources).toHaveLength(0);
  setSoundEnabled(true, true);
  await Promise.resolve();
  expect(sources).toHaveLength(1);
  playSound('open', 'muted');
  playSound('open', 'new');
  playSound('open', 'new');
  playSound('answer', 'overlap');
  expect(sources).toHaveLength(3);
  expect(sources.every((source) => source.start.mock.calls.length === 1)).toBe(
    true,
  );
  expect(fetcher).toHaveBeenCalledTimes(soundKinds.length);
  expect(engine.decodeAudioData).toHaveBeenCalledTimes(soundKinds.length);
  setSoundEnabled(false);
  expect(sources.every((source) => source.stop.mock.calls.length === 1)).toBe(
    true,
  );
  playSound('answer', 'late');
  expect(sources).toHaveLength(3);
});

it('retries a failed file without replaying an event from before it was ready', async () => {
  const {fetcher, sources} = audioEngine();
  fetcher.mockRejectedValueOnce(new Error('Offline'));
  const {prepareSounds, playSound, setSoundEnabled} =
    await import('../lib/audio');
  await prepareSounds();
  playSound('open', 'missed');
  await prepareSounds();
  expect(fetcher).toHaveBeenCalledTimes(soundKinds.length + 1);
  setSoundEnabled(true);
  await Promise.resolve();
  playSound('open', 'missed');
  expect(sources).toHaveLength(0);
  playSound('open', 'fresh');
  expect(sources).toHaveLength(1);
});

it('keeps the page usable when browser audio is unavailable', async () => {
  vi.stubGlobal('AudioContext', undefined);
  const {prepareSounds, playSound, setSoundEnabled} =
    await import('../lib/audio');
  await prepareSounds();
  expect(() => {
    setSoundEnabled(true, true);
    playSound('open', 'event');
    setSoundEnabled(false);
  }).not.toThrow();
});

it('plays a deduplicated attendance call while muted without changing ordinary sound settings', async () => {
  const {sources} = audioEngine();
  const {
    prepareSounds,
    armAttentionSound,
    playAttentionSound,
    playSound,
    setSoundEnabled,
  } = await import('../lib/audio');
  await prepareSounds();
  armAttentionSound();
  await Promise.resolve();
  playAttentionSound('member:1');
  playAttentionSound('member:1');
  expect(sources).toHaveLength(1);
  setSoundEnabled(false);
  expect(sources[0].stop).not.toHaveBeenCalled();
  playSound('open', 'still-muted');
  expect(sources).toHaveLength(1);
});
