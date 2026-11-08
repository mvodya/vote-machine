// Shared names keep preload links and decoded samples in sync
export const soundKinds = [
  'open',
  'close',
  'minute',
  'tick',
  'answer',
  'submit',
  'call',
] as const;
export type Sound = (typeof soundKinds)[number];
