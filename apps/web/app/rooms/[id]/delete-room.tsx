'use client';
import {useI18n} from '../../../components/language-provider';
import {useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Trash2} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Panel} from '../../../components/ui/panel';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {isRoom, type Room} from '../../../lib/rooms';
// Fetch the current revision before confirming permanent deletion
export function DeleteRoom({
  room,
  onDenied,
}: {
  // Room currently managed by this admin
  room: Room;
  // Remove private content when access is lost
  onDenied: () => void;
}) {
  const {t} = useI18n();
  const router = useRouter();
  const trigger = useRef<HTMLButtonElement>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // A stale settings screen must not delete a different room revision
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${room.id}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok || !isRoom(body.room) || body.room.id !== room.id)
        throw new Error();
      setRevision(body.room.revision);
    } catch {
      setError('Не удалось подготовить удаление, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }
  // The database removes access and data in one transaction
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/rooms/${room.id}`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({confirmation: room.id, revision}),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (response.status === 409) {
        setError('Комната изменилась, закройте окно и повторите удаление');
        return;
      }
      if (!response.ok || (await response.json()).deletedId !== room.id)
        throw new Error();
      router.replace('/');
    } catch {
      setError('Не удалось удалить комнату, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel aria-label={t('Удаление комнаты')}>
      <h2 className="text-lg font-semibold">{t('Удаление комнаты')}</h2>
      <p className="mt-3 text-sm text-muted">
        {t('Удаляются вопросы, ответы, ссылки участников и доступ к комнате')}
      </p>
      <Button
        ref={trigger}
        className="mt-4"
        variant="negative"
        startIcon={<Trash2 />}
        disabled={busy}
        onClick={() => void confirm()}
      >
        {t('Удалить комнату')}
      </Button>
      {error && revision === null && (
        <p role="alert" className="mt-3 text-sm text-error-ink">
          {t(error)}
        </p>
      )}
      {revision !== null && (
        <ConfirmDialog
          title={t('Удалить комнату?')}
          returnFocusRef={trigger}
          description={t(
            'Комната «{value0}», ее вопросы, ответы и ссылки будут удалены Восстановление возможно только из резервной копии',
            {value0: room.name},
          )}
          confirmLabel={t('Удалить комнату')}
          busyLabel={t('Удаляем…')}
          busy={busy}
          error={t(error)}
          onConfirm={() => void remove()}
          onClose={() => {
            setRevision(null);
            setError('');
          }}
        />
      )}
    </Panel>
  );
}
