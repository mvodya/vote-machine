'use client';
import {useI18n} from '../../../components/language-provider';
import {useEffect, useRef, useState} from 'react';
import {useLive} from '../../../lib/use-live';
import {Panel} from '../../../components/ui/panel';
import {CheckboxField} from '../../../components/ui/checkbox-field';
import {Spinner} from '../../../components/ui/loading';
// Save only the room-wide summary rule so other settings stay intact
export function ResultsPolicy({
  roomId,
  onDenied,
}: {
  roomId: string;
  onDenied: () => void;
}) {
  const {t} = useI18n();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const saving = useRef(false);
  const serial = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const live = useLive(`/api/rooms/${roomId}/events`, onDenied);
  const path = `/api/rooms/${roomId}/experience`;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      if (saving.current) return;
      const started = serial.current;
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (!response.ok || typeof data.showAllResults !== 'boolean')
          throw new Error();
        if (started === serial.current && !saving.current)
          setEnabled(data.showAllResults);
      } catch {
        if (!controller.signal.aborted)
          setError('Не удалось загрузить настройку результатов');
      }
    }
    void load();
    return () => controller.abort();
  }, [path, onDenied, live.version]);
  // Restore the saved value if the new setting cannot be saved
  async function save(value: boolean) {
    if (busy) return;
    const before = enabled;
    saving.current = true;
    serial.current += 1;
    setEnabled(value);
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({showAllResults: value}),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const data = await response.json();
      if (!response.ok || typeof data.showAllResults !== 'boolean')
        throw new Error();
      setEnabled(data.showAllResults);
    } catch {
      setEnabled(before);
      setError('Не удалось сохранить настройку результатов');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2 className="mb-4 text-lg font-semibold">{t('Общие результаты')}</h2>
      {enabled === null ? (
        <Spinner />
      ) : (
        <CheckboxField
          id="show-all-results"
          label={t('Показывать все результаты')}
          hint={t(
            'Общая статистика для отвечающих, доступ к результатам отдельных вопросов задается в самих вопросах',
          )}
          checked={enabled}
          disabled={busy}
          onChange={(event) => void save(event.target.checked)}
        />
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error-ink">
          {t(error)}
        </p>
      )}
    </Panel>
  );
}
