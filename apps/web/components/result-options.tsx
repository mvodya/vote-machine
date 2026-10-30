'use client';
import {useI18n} from './language-provider';
import {Markdown} from './markdown';
import type {VoteResult} from '../lib/results';

// Share the same result bars with the room and the interactive demo
export function ResultOptions({
  options,
  viewer,
}: {
  // Counts and percentages from an allowed snapshot
  options: NonNullable<VoteResult['options']>;
  // Media access stays with the owning room
  viewer: {roomId: string; linkId?: string};
}) {
  const {t} = useI18n();
  return (
    <ul className="mt-4 space-y-4">
      {options.map((option) => (
        <li key={option.id}>
          <Markdown source={option.content} viewer={viewer} />
          <div className="mt-2 flex justify-between text-sm tabular-nums">
            <span>
              {t('Голосов: ')}
              {option.count}
            </span>
            <span>{option.percent}%</span>
          </div>
          <div
            className="mt-1 h-2 overflow-hidden rounded-full bg-accent"
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full bg-primary motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
              style={{width: `${option.percent}%`}}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
