'use client';
import {useCallback, useEffect, useRef, useState, type FormEvent} from 'react';
import {Clock, UserRound, Ban} from 'lucide-react';
import {useI18n} from '../../../components/language-provider';
import {RoomExperience} from '../../../components/room-experience';
import {AttendanceCall} from '../../../components/attendance-call';
import {Button} from '../../../components/ui/button';
import {Panel} from '../../../components/ui/panel';
import {Form} from '../../../components/ui/form';
import {TextField} from '../../../components/ui/text-field';
import {Loading} from '../../../components/ui/loading';
import {EmptyState} from '../../../components/ui/empty-state';
import {useQuestionPresence} from '../../../lib/use-question-presence';
import {useLive} from '../../../lib/use-live';
import {armAttentionSound, playAttentionSound} from '../../../lib/audio';
import {
  registrationStatus,
  type RegistrationStatus,
} from '../../../lib/registrations';
import {ParticipantJourney} from './journey';

// A group cookie owns the registration, an approved child cookie owns voting
export function RegistrationEntry({
  id,
  roomName,
  onDenied,
}: {
  id: string;
  roomName: string;
  onDenied: () => void;
}) {
  const {t} = useI18n();
  useQuestionPresence(id, null, null, onDenied);
  const live = useLive(`/api/vote/${id}/events`, onDenied);
  const [status, setStatus] = useState<RegistrationStatus | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [suspended, setSuspended] = useState(false);
  const lastCall = useRef<string | null>(null);
  const [call, setCall] = useState<{
    key: string;
    duration: number;
    name: string;
  } | null>(null);
  const closeCall = useCallback(() => setCall(null), []);
  // Capture gestures even when the general sound switch stays off
  useEffect(() => {
    document.addEventListener('pointerdown', armAttentionSound, true);
    document.addEventListener('keydown', armAttentionSound, true);
    return () => {
      document.removeEventListener('pointerdown', armAttentionSound, true);
      document.removeEventListener('keydown', armAttentionSound, true);
    };
  }, []);
  // Keep one call baseline across live snapshots
  const apply = useCallback((data: RegistrationStatus) => {
    document.documentElement.dataset.accent = data.accent;
    const sequence = data.member?.callSequence ?? '0';
    if (
      lastCall.current !== null &&
      BigInt(sequence) > BigInt(lastCall.current) &&
      data.member?.calledAt
    ) {
      // Network delay must not shorten a fresh call shown on this device
      const age =
        Date.parse(data.serverTime) - Date.parse(data.member.calledAt);
      if (age >= 0 && age < 30000) {
        const key = `registration-call:${data.member.id}:${sequence}`;
        playAttentionSound(key);
        setCall({key, duration: 3000, name: data.member.name});
      }
    }
    lastCall.current = sequence;
    setStatus(data);
    setSuspended(false);
    setFailed(false);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Recheck approval without exposing a private identity while waiting
    async function load() {
      if (busy) return;
      try {
        const response = await fetch(`/api/vote/${id}/registration`, {
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
        const data = registrationStatus(await response.json());
        if (!response.ok || !data) throw new Error();
        if (!controller.signal.aborted) apply(data);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), live.connected ? 10000 : 2000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, live.version, live.connected, attempt, busy, onDenied, apply]);
  // Hide private content until the group confirms access again
  const refreshAccess = useCallback(() => {
    setSuspended(true);
    setAttempt((value) => value + 1);
  }, []);
  // The server binds the entered name to this browser
  async function register(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
    armAttentionSound();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/vote/${id}/registration`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: name.trim()}),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        setError(
          body.error === 'same_name'
            ? 'Укажите другое имя'
            : body.error === 'registration_closed'
              ? 'Регистрация закрыта'
              : 'Не удалось зарегистрироваться, попробуйте снова',
        );
        return;
      }
      const data = registrationStatus(body);
      if (!data) throw new Error();
      apply(data);
      setName('');
    } catch {
      setError('Не удалось зарегистрироваться, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }
  const member = status?.member;
  const active =
    status?.votingId &&
    member?.state === 'approved' &&
    !member.blocked &&
    !suspended;
  return (
    <>
      <h1 className="mt-8 text-2xl font-semibold">{roomName}</h1>
      {status && (
        <p className="mt-3 text-sm text-muted">
          {member?.name ? `${member.name} · ` : ''}
          {status.groupName}
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-4 text-sm text-error-ink">
          {t('Не удалось обновить регистрацию, пробуем снова')}
        </p>
      )}
      {!status ? (
        <Loading label={t('Проверяем регистрацию…')} rows={2} />
      ) : active ? (
        <RoomExperience
          id={status.votingId!}
          admin={false}
          active
          onDenied={refreshAccess}
        >
          <ParticipantJourney
            linkId={status.votingId!}
            onDenied={refreshAccess}
          />
        </RoomExperience>
      ) : (
        <Panel className="mt-6">
          {member?.blocked ? (
            <EmptyState
              icon={<Ban />}
              title={t('Доступ заблокирован')}
              description={t('Обратитесь к администратору')}
            />
          ) : member?.state === 'pending' ? (
            <EmptyState
              icon={<Clock />}
              title={t('Ожидаем подтверждения')}
              description={t('Администратор проверяет вашу регистрацию')}
            />
          ) : suspended && member?.state === 'approved' ? (
            <Loading label={t('Проверяем регистрацию…')} rows={2} />
          ) : status.closed ? (
            <EmptyState icon={<Ban />} title={t('Регистрация закрыта')} />
          ) : (
            <Form onSubmit={(event) => void register(event)}>
              <h2 className="text-lg font-semibold">{t('Регистрация')}</h2>
              {member?.state === 'rejected' && (
                <p role="alert" className="text-sm text-error-ink">
                  {t('В регистрации отказано, укажите другое имя')}
                </p>
              )}
              <TextField
                id="registration-name"
                label={t('Ваше имя')}
                value={name}
                maxLength={200}
                required
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
              {error && (
                <p role="alert" className="text-sm text-error-ink">
                  {t(error)}
                </p>
              )}
              <Button
                type="submit"
                startIcon={<UserRound />}
                disabled={busy || !name.trim()}
              >
                {busy ? t('Сохраняем…') : t('Зарегистрироваться')}
              </Button>
            </Form>
          )}
        </Panel>
      )}
      {call && (
        <AttendanceCall
          key={call.key}
          name={call.name}
          duration={call.duration}
          onDone={closeCall}
        />
      )}
    </>
  );
}
