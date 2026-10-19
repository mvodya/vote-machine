export const accents = [
  'green',
  'blue',
  'violet',
  'rose',
  'orange',
  'amber',
  'teal',
] as const;
export type Accent = (typeof accents)[number];
// Accept only colors supported by both themes
export function isAccent(value: unknown): value is Accent {
  return accents.some((color) => color === value);
}
