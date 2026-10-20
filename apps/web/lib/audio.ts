import {soundKinds, type Sound} from './sounds';
export type {Sound} from './sounds';
let enabled = false;
let context: AudioContext | undefined;
const played = new Set<string>();
// Decoded samples can start without another download or decode
const buffers = new Map<Sound, AudioBuffer>();
const loading = new Map<Sound, Promise<void>>();
// Keep active samples so muting also stops sounds already playing
const active = new Set<AudioBufferSourceNode>();

// Load and decode while muted, the browser output stays suspended
export async function prepareSounds() {
  if (typeof AudioContext === 'undefined') return;
  try {
    context ??= new AudioContext({latencyHint: 'interactive'});
  } catch {
    return;
  }
  const engine = context;
  await Promise.allSettled(
    soundKinds.map((kind) => {
      if (buffers.has(kind)) return Promise.resolve();
      const existing = loading.get(kind);
      if (existing) return existing;
      const request = (async () => {
        try {
          const response = await fetch(`/sounds/${kind}.mp3`, {
            cache: 'force-cache',
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error('Sound unavailable');
          const buffer = await engine.decodeAudioData(
            await response.arrayBuffer(),
          );
          buffers.set(kind, buffer);
        } finally {
          // Failed downloads may be retried on the next user gesture
          loading.delete(kind);
        }
      })();
      loading.set(kind, request);
      return request;
    }),
  );
}

// Resume from a trusted gesture, including after a full page reload
export function unlockSound() {
  if (enabled && context && context.state !== 'running')
    void context.resume().catch(() => {});
}

// Start a fresh source from a ready sample with no network wait
function startSound(kind: Sound) {
  const buffer = buffers.get(kind);
  if (!enabled || !context || context.state !== 'running' || !buffer) return;
  const source = context.createBufferSource();
  const volume = context.createGain();
  source.buffer = buffer;
  volume.gain.value = 0.3;
  source.connect(volume);
  volume.connect(context.destination);
  source.onended = () => {
    active.delete(source);
    source.disconnect();
    volume.disconnect();
  };
  active.add(source);
  source.start();
}

// Muting stops current samples and never queues old events
export function setSoundEnabled(value: boolean, prime = false) {
  enabled = value;
  if (!value) {
    active.forEach((source) => source.stop());
    active.clear();
    return;
  }
  void prepareSounds();
  unlockSound();
  // A ready sample confirms the explicit sound button gesture
  if (prime && context)
    void context
      .resume()
      .then(() => startSound('open'))
      .catch(() => {});
}

// Repeated snapshots and duplicate timers must stay silent
export function playSound(kind: Sound, key: string) {
  if (played.has(key)) return;
  // Muted or not yet ready events must not replay later
  played.add(key);
  if (played.size > 2000) played.delete(played.values().next().value!);
  startSound(kind);
}
