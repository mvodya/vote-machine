'use client';
import {useI18n} from '../../../components/language-provider';
import {useEffect, useRef, useState} from 'react';
import {Panel} from '../../../components/ui/panel';
import {CheckboxField} from '../../../components/ui/checkbox-field';
import {validCursor} from '../../../lib/voting-links';
type Policy = {
  // Rule for questions that have not opened yet
  lockAfterOpen: boolean;
  // Current room version
  revision: string;
};
// Check the saved rule before using its version
async function readPolicy(response: Response): Promise<Policy> {
  if (!response.ok) throw new Error('Policy unavailable');
  const body = await response.json();
  if (
    typeof body.policy?.lockAfterOpen !== 'boolean' ||
    !validCursor(body.policy?.revision)
  )
    throw new Error('Invalid policy');
  return body.policy;
}
// Save the room rule as soon as the checkbox changes
export function QuestionPolicy({
  roomId,
  onDenied,
}: {
  // Room whose future questions use this rule
  roomId: string;
  // Leave settings if access is lost
  onDenied: () => void;
}) {
  const {t} = useI18n();
  // Last saved rule and room version
  const [policy, setPolicy] = useState<Policy | null>(null);
  // Current checkbox value
  const [locked, setLocked] = useState(true);
  // Whether a write is running
  const [busy, setBusy] = useState(false);
  // Result or error message
  const [notice, setNotice] = useState('');
  // Prevent repeated writes before React updates the checkbox
  const running = useRef(false);
  const path = `/api/rooms/${roomId}/question-policy`;
  useEffect(() => {
    const controller = new AbortController();
    // Read the initial rule without adding a separate load action
    async function load() {
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
        const value = await readPolicy(response);
        if (!controller.signal.aborted) {
          setPolicy(value);
          setLocked(value.lockAfterOpen);
        }
      } catch {
        if (!controller.signal.aborted)
          setNotice('Не удалось загрузить правило, обновите страницу');
      }
    }
    void load();
    return () => controller.abort();
  }, [path, onDenied]);
  // Refresh a stale version and retry only the selected setting
  async function save(next: boolean) {
    if (running.current || !policy) return;
    running.current = true;
    setBusy(true);
    setLocked(next);
    setNotice('');
    let latest = policy;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(path, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            lockAfterOpen: next,
            revision: latest.revision,
          }),
          signal: AbortSignal.timeout(12000),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        // A name edit may have changed the room version
        if (response.status === 409 && attempt === 0) {
          const refreshed = await fetch(path, {
            cache: 'no-store',
            signal: AbortSignal.timeout(12000),
          });
          if (refreshed.status === 401) {
            onDenied();
            return;
          }
          latest = await readPolicy(refreshed);
          if (latest.lockAfterOpen !== next) continue;
        } else {
          latest = await readPolicy(response);
        }
        setPolicy(latest);
        setLocked(latest.lockAfterOpen);
        setNotice('Правило сохранено');
        return;
      }
    } catch {
      setPolicy(latest);
      setLocked(latest.lockAfterOpen);
      setNotice('Не удалось сохранить правило, попробуйте снова');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Panel aria-label={t('Редактирование вопросов')}>
      <h2 className="mb-5 text-lg font-semibold">
        {t('Редактирование вопросов')}
      </h2>
      <CheckboxField
        id="question-edit-rule"
        label={t('Запретить редактирование после открытия')}
        hint={t(
          'Правило фиксируется для каждого вопроса при первом открытии, черновики всегда редактируемы',
        )}
        disabled={!policy || busy}
        checked={locked}
        onChange={(event) => void save(event.target.checked)}
      />
      {(busy || notice) && (
        <p role="status" className="mt-4 text-sm text-muted">
          {busy ? t('Сохраняем…') : notice}
        </p>
      )}
    </Panel>
  );
}
