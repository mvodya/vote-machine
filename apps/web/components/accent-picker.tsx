'use client';
import {useEffect, useState} from 'react';
import {Check} from 'lucide-react';
import {Button} from './ui/button';
import {accents, isAccent} from '../lib/experience';
const labels = [
  'Зеленый',
  'Синий',
  'Фиолетовый',
  'Розовый',
  'Оранжевый',
  'Янтарный',
  'Бирюзовый',
];
const colors = [
  '#245442',
  '#2458a4',
  '#6840a4',
  '#a33461',
  '#a34615',
  '#8b5c0c',
  '#14676b',
];
// Save the room palette at once, like the other room settings
export function AccentPicker({
  roomId,
  onDenied,
}: {
  roomId: string;
  onDenied: () => void;
}) {
  const [selected, setSelected] = useState(() =>
    typeof document === 'undefined'
      ? 'green'
      : (document.documentElement.dataset.accent ?? 'green'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Another admin device can change the same palette
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const color = document.documentElement.dataset.accent;
      if (isAccent(color)) setSelected(color);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-accent'],
    });
    return () => observer.disconnect();
  }, []);
  // Change only the palette, leaving other room settings alone
  async function save(accent: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${roomId}/experience`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({accent}),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const data = await response.json();
      if (!response.ok || !isAccent(data.accent)) throw new Error();
      document.documentElement.classList.add('theme-changing');
      document.documentElement.setAttribute('data-accent', data.accent);
      setSelected(data.accent);
      setTimeout(
        () => document.documentElement.classList.remove('theme-changing'),
        350,
      );
    } catch {
      setError('Не удалось сохранить цвет');
    } finally {
      setBusy(false);
    }
  }
  return (
    <fieldset className="mt-6">
      <legend className="mb-3 text-sm font-medium">
        Акцентный цвет комнаты
      </legend>
      <div className="flex flex-wrap gap-2">
        {accents.map((color, index) => (
          <Button
            key={color}
            variant="swatch"
            disabled={busy}
            title={labels[index]}
            aria-label={labels[index]}
            aria-pressed={selected === color}
            onClick={() => void save(color)}
          >
            <span
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-white"
              style={{backgroundColor: colors[index]}}
            >
              {selected === color && <Check className="size-4" />}
            </span>
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-ink">
          {error}
        </p>
      )}
    </fieldset>
  );
}
