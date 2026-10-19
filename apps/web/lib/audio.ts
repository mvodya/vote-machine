export type Sound = 'open' | 'close' | 'minute' | 'tick' | 'answer' | 'submit';
let enabled = false;
const played = new Set<string>();
const players = new Map<Sound, HTMLAudioElement>();
// A browser gesture enables audio, never enable it on page load
export function setSoundEnabled(value: boolean, prime = false) {
  enabled = value;
  if (!value) {
    players.forEach((player) => {
      player.pause();
      player.currentTime = 0;
    });
    return;
  }
  for (const kind of [
    'open',
    'close',
    'minute',
    'tick',
    'answer',
    'submit',
  ] as Sound[]) {
    const player = players.get(kind) ?? new Audio(`/sounds/${kind}.wav`);
    players.set(kind, player);
    player.volume = 0.3;
  }
  // Prime one short sound from the explicit button gesture
  if (prime)
    void players
      .get('open')
      ?.play()
      .catch(() => {});
}
// Repeated snapshots and duplicate timers must stay silent
export function playSound(kind: Sound, key: string) {
  if (played.has(key)) return;
  // Muted events must not replay when sound is enabled later
  played.add(key);
  if (played.size > 2000) played.delete(played.values().next().value!);
  if (!enabled) return;
  const player = players.get(kind);
  if (!player) return;
  player.currentTime = 0;
  void player.play().catch(() => {});
}
