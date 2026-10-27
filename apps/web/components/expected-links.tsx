'use client';
import {Spinner} from './ui/loading';
import {useEffect, useState} from 'react';
import {CheckboxField} from './ui/checkbox-field';
import {Button} from './ui/button';
import {isVotingLink, type VotingLink} from '../lib/voting-links';
// Show the concrete personal links that will end this opening
export function ExpectedLinks({
  roomId,
  selected,
  onChange,
  disabled,
  onBusy,
  onDenied,
}: {
  roomId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onDenied: () => void;
}) {
  const [links, setLinks] = useState<VotingLink[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      onBusy(true);
      try {
        let after = '0';
        const found: VotingLink[] = [];
        do {
          const response = await fetch(
            `/api/rooms/${roomId}/links?after=${after}`,
            {cache: 'no-store', signal: controller.signal},
          );
          if (response.status === 401) {
            onDenied();
            return;
          }
          const data = await response.json();
          if (
            !response.ok ||
            !Array.isArray(data.links) ||
            !data.links.every(isVotingLink)
          )
            throw new Error();
          found.push(
            ...data.links.filter(
              (link: VotingLink) => link.mode === 'personal',
            ),
          );
          after = data.nextCursor;
        } while (after && !controller.signal.aborted);
        if (!controller.signal.aborted) setLinks(found);
      } catch {
        if (!controller.signal.aborted)
          setError('Не удалось загрузить персональные ссылки');
      } finally {
        if (!controller.signal.aborted) onBusy(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      onBusy(false);
    };
  }, [roomId, onBusy, onDenied]);
  const missing = selected.filter(
    (id) => !links.some((link) => link.id === id),
  );
  return (
    <section
      aria-label="Ожидаемые участники"
      className="space-y-3 rounded-2xl border border-border p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">Ожидаемые участники: {selected.length}</h3>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={() =>
            onChange(
              links.filter((link) => !link.revoked).map((link) => link.id),
            )
          }
        >
          Выбрать действующие ссылки
        </Button>
      </div>
      <p className="text-xs text-muted">
        Многоразовые и безымянные ручные ответы не заменяют выбранных
        участников, завершение закроет прием всех ответов
      </p>
      <div className="max-h-72 space-y-2 overflow-y-auto">
        {links.map((link) => (
          <CheckboxField
            key={link.id}
            id={`expected-${link.id}`}
            label={`${link.name}${link.revoked ? ' (отозвана)' : ''}`}
            disabled={disabled || link.revoked}
            checked={selected.includes(link.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, link.id]
                  : selected.filter((id) => id !== link.id),
              )
            }
          />
        ))}
      </div>
      {missing.length > 0 && <Spinner label="Загружаем выбранные ссылки…" />}
      {!selected.length && (
        <p className="text-sm text-error-ink">
          Выберите хотя бы одну персональную ссылку
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-ink">
          {error}
        </p>
      )}
    </section>
  );
}
