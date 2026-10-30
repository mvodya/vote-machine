// Keep every waiting and open phase exactly one minute long
export function demoQuestionCycle(
  startedAt: number,
  now: number,
): {
  step: number;
  state: 'scheduled' | 'open';
  endsAt: string;
} {
  const step = Math.floor(Math.max(0, now - startedAt) / 60000);
  return {
    step,
    state: step % 2 ? 'open' : 'scheduled',
    endsAt: new Date(startedAt + (step + 1) * 60000).toISOString(),
  };
}
