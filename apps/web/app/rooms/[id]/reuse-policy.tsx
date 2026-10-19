'use client';
import {useEffect, useState} from 'react';
import {CheckboxField} from '../../../components/ui/checkbox-field';
import {Panel} from '../../../components/ui/panel';
// Auto-save the room rule for additional reusable runs
export function ReusePolicy({
  roomId,
  onDenied,
}: {
  roomId: string;
  onDenied: () => void;
}) {
  const [policy, setPolicy] = useState<{
    enabled: boolean;
    revision: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/rooms/${roomId}/reuse-policy`;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(path, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (!response.ok) throw new Error();
        setPolicy(data.policy);
      } catch {
        if (!controller.signal.aborted)
          setError('Не удалось загрузить правило повторного голосования');
      }
    }
    void load();
    return () => controller.abort();
  }, [path, onDenied]);
  // Retry a stale room version once without changing the selected rule
  async function save(enabled: boolean) {
    if (!policy || busy) return;
    setBusy(true);
    setError('');
    try {
      let revision = policy.revision;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(path, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({enabled, revision}),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (response.status === 409 && attempt === 0) {
          const latest = await (await fetch(path, {cache: 'no-store'})).json();
          revision = latest.policy.revision;
          continue;
        }
        const data = await response.json();
        if (!response.ok) throw new Error();
        setPolicy(data.policy);
        return;
      }
    } catch {
      setError('Не удалось сохранить правило повторного голосования');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <h2 className="mb-4 text-lg font-semibold">Повторное голосование</h2>
      {policy && (
        <CheckboxField
          id="reusable-repeat"
          label="Разрешить повторное голосование с одного устройства"
          hint="Для многоразовых ссылок"
          checked={policy.enabled}
          disabled={busy}
          onChange={(event) => void save(event.target.checked)}
        />
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error-ink">
          {error}
        </p>
      )}
    </Panel>
  );
}
