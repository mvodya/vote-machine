'use client';
import {useEffect, useState} from 'react';
import {
  ArrowLeft,
  BellRing,
  Check,
  X,
  Ban,
  ShieldCheck,
  Copy,
  QrCode,
  Download,
  Users,
  Clock,
  TriangleAlert,
  Pencil,
  Save,
} from 'lucide-react';
import {useI18n} from '../../../components/language-provider';
import styles from '../../../components/attendance-call.module.css';
import {TextField} from '../../../components/ui/text-field';
import {Form} from '../../../components/ui/form';
import {Button} from '../../../components/ui/button';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {Tabs} from '../../../components/ui/tabs';
import {Loading} from '../../../components/ui/loading';
import {Pagination} from '../../../components/ui/pagination';
import {EmptyState} from '../../../components/ui/empty-state';
import {LinkQrDialog} from '../../../components/link-qr-dialog';
import {useLive} from '../../../lib/use-live';
import {type VotingLink} from '../../../lib/voting-links';
import {
  registrationMember,
  registrationUrl,
  registrationsCsv,
  type RegisteredMember,
} from '../../../lib/registrations';
import {markdownSummary} from '../../../lib/markdown';

// Group moderation never changes an existing respondent's voting identity
export function RegistrationMembers({
  roomId,
  group,
  onClose,
  onDenied,
}: {
  roomId: string;
  group: VotingLink;
  onClose: () => void;
  onDenied: () => void;
}) {
  const {t} = useI18n();
  const live = useLive(`/api/rooms/${roomId}/events`, onDenied);
  const [members, setMembers] = useState<RegisteredMember[]>([]);
  const [filter, setFilter] = useState('registered');
  const [pendingCount, setPendingCount] = useState(0);
  const [registeredCount, setRegisteredCount] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // Each successful call keeps its own short pulse
  const [calls, setCalls] = useState<Record<string, number>>({});
  useEffect(() => {
    const ends = Object.values(calls);
    if (!ends.length) return;
    const timer = setTimeout(
      () =>
        setCalls((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, end]) => end > Date.now()),
          ),
        ),
      Math.max(0, Math.min(...ends) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [calls]);
  const [cursors, setCursors] = useState(['0']);
  const [next, setNext] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [qr, setQr] = useState<RegisteredMember | null>(null);
  const base = `/api/rooms/${roomId}/links/${group.id}/members`;
  const cursor = cursors.at(-1)!;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Refresh this page after a live signal or reconnect
    async function load() {
      try {
        const response = await fetch(
          `${base}?${new URLSearchParams({after: cursor, filter})}`,
          {cache: 'no-store', signal: controller.signal},
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.members)) throw new Error();
        if (controller.signal.aborted) return;
        setMembers(data.members);
        setNext(data.nextCursor);
        setPendingCount(data.pendingCount);
        setRegisteredCount(data.registeredCount);
      } catch {
        if (!controller.signal.aborted)
          setNotice('Не удалось обновить регистрации');
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void load(), live.connected ? 30000 : 2000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [base, cursor, filter, attempt, live.version, live.connected, onDenied]);
  // Use the last revision so old actions cannot replace newer decisions
  async function action(
    member: RegisteredMember,
    value: string,
    name?: string,
  ) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${base}/${member.id}`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          action: value,
          revision: member.revision,
          ...(name !== undefined ? {name} : {}),
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (response.status === 409) {
        setNotice('Данные изменились, повторите действие');
        setAttempt((x) => x + 1);
        return;
      }
      if (!response.ok) throw new Error();
      if (value === 'call')
        setCalls((current) => ({...current, [member.id]: Date.now() + 3000}));
      if (value === 'rename') setEditing(null);
      setAttempt((x) => x + 1);
    } catch {
      setNotice('Не удалось выполнить действие');
    } finally {
      setBusy(false);
    }
  }
  // Fetch recovery credentials only when the admin asks to copy them
  async function copy(member: RegisteredMember) {
    try {
      const response = await fetch(`${base}/${member.id}/secret`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (!response.ok) throw new Error();
      const {token} = await response.json();
      await navigator.clipboard.writeText(
        registrationUrl(location.origin, group.id, member.id, token),
      );
      setNotice('Ссылка скопирована');
    } catch {
      setNotice('Не удалось скопировать ссылку');
    }
  }
  // Walk the same bounded pages as the list and keep secrets out of CSV
  async function download() {
    if (busy) return;
    setBusy(true);
    try {
      let after = '0';
      const seen = new Set<string>();
      const all: RegisteredMember[] = [];
      for (;;) {
        const response = await fetch(
          `${base}?${new URLSearchParams({after, filter: 'all'})}`,
          {cache: 'no-store'},
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (!response.ok) throw new Error();
        const data = await response.json();
        const rows = data.members.map((m: unknown) =>
          registrationMember(m, true),
        );
        if (rows.some((m: unknown) => !m)) throw new Error();
        all.push(...rows);
        if (!data.nextCursor) break;
        // Stop a repeated cursor instead of downloading the same page forever
        if (seen.has(data.nextCursor)) throw new Error();
        seen.add(data.nextCursor);
        after = data.nextCursor;
      }
      const url = URL.createObjectURL(
        new Blob([registrationsCsv(all, t, group.name)], {
          type: 'text/csv;charset=utf-8',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'registrations.csv';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setNotice('Не удалось скачать регистрации');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel>
      <SectionHeader title={group.name}>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            startIcon={<Download />}
            disabled={busy}
            onClick={() => void download()}
          >
            {t('Скачать CSV')}
          </Button>
          <Button
            variant="secondary"
            startIcon={<ArrowLeft />}
            onClick={onClose}
          >
            {t('Вернуться')}
          </Button>
        </div>
      </SectionHeader>
      <p className="mt-3 text-xs text-muted">
        {t('Зарегистрировано: {count}', {count: registeredCount})}
      </p>
      {(group.requireModeration || pendingCount > 0) && (
        <div className="mt-5">
          <Tabs
            group="registration-members"
            label={t('Регистрации')}
            value={filter}
            onChange={(value) => {
              setFilter(value);
              setCursors(['0']);
              setLoading(true);
            }}
            items={[
              {
                id: 'registered',
                label: t('Зарегистрированные'),
                icon: <Users />,
              },
              {
                id: 'pending',
                label: `${t('Ожидающие подтверждения')}${pendingCount > 0 ? ` (${pendingCount})` : ''}`,
                attention: pendingCount > 0,
                icon: <Clock />,
              },
            ]}
          />
        </div>
      )}
      {notice && (
        <p role="status" className="mt-4 text-sm text-muted">
          {t(notice)}
        </p>
      )}
      {loading ? (
        <Loading label={t('Загружаем регистрации…')} />
      ) : members.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title={t(
            filter === 'pending'
              ? 'Нет ожидающих подтверждения'
              : 'Зарегистрированных пока нет',
          )}
        >
          {filter === 'registered' && pendingCount > 0 && (
            <Button
              variant="secondary"
              className="mt-5"
              startIcon={<Check />}
              onClick={() => {
                setFilter('pending');
                setCursors(['0']);
                setLoading(true);
              }}
            >
              {t('Подтвердить ожидающих')}
            </Button>
          )}
        </EmptyState>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {members.map((member) => (
            <li
              key={member.id}
              aria-label={member.name}
              className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between"
            >
              {editing === member.id ? (
                <Form
                  className="w-full"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action(member, 'rename', editName.trim());
                  }}
                >
                  <TextField
                    id={`member-name-${member.id}`}
                    label={t('Имя респондента')}
                    value={editName}
                    maxLength={200}
                    required
                    disabled={busy}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      startIcon={<Save />}
                      disabled={busy || !editName.trim()}
                    >
                      {t('Сохранить')}
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      {t('Отмена')}
                    </Button>
                  </div>
                </Form>
              ) : (
                <>
                  <div className="min-w-0">
                    <h3 className="font-medium break-words">{member.name}</h3>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
                      <span
                        className={
                          member.blocked || member.state === 'rejected'
                            ? 'text-error-ink'
                            : ''
                        }
                      >
                        {t(
                          member.blocked
                            ? 'Заблокирован'
                            : member.state === 'approved'
                              ? 'Подтвержден'
                              : member.state === 'pending'
                                ? 'Ожидает подтверждения'
                                : 'Отказано',
                        )}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      {!member.online ? (
                        <p>{t('Не в сети')}</p>
                      ) : member.questions?.length ? (
                        member.questions.map((q) => (
                          <p key={q.id}>
                            {t('Смотрит:')}{' '}
                            {markdownSummary(q.preview) || t('Вопрос')}
                          </p>
                        ))
                      ) : (
                        <p>{t('Онлайн')}</p>
                      )}
                    </div>
                    {(member.online ?? 0) > 1 && (
                      <p className="mt-2 inline-flex items-center gap-2 text-xs text-warning-ink">
                        <TriangleAlert aria-hidden="true" className="size-4" />
                        {t('Открыто на {count} устройствах', {
                          count: member.online!,
                        })}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {member.state !== 'approved' && (
                      <Button
                        variant="approve"
                        startIcon={<Check />}
                        disabled={busy}
                        onClick={() => void action(member, 'approve')}
                      >
                        {t('Подтвердить')}
                      </Button>
                    )}
                    {member.state === 'pending' && (
                      <Button
                        variant="reject"
                        startIcon={<X />}
                        disabled={busy}
                        onClick={() => void action(member, 'reject')}
                      >
                        {t('Отказать')}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      startIcon={<Copy />}
                      title={t('Скопировать ссылку')}
                      aria-label={t('Ссылка для входа: {name}', {
                        name: member.name,
                      })}
                      onClick={() => void copy(member)}
                    />
                    <Button
                      variant="ghost"
                      startIcon={<Pencil />}
                      disabled={busy}
                      title={t('Изменить имя')}
                      aria-label={t('Изменить имя: {value0}', {
                        value0: member.name,
                      })}
                      onClick={() => {
                        setEditing(member.id);
                        setEditName(member.name);
                      }}
                    />
                    <Button
                      variant="ghost"
                      startIcon={<QrCode />}
                      title="QR Code"
                      aria-label={`QR Code: ${member.name}`}
                      onClick={(event) => {
                        event.currentTarget.focus();
                        setQr(member);
                      }}
                    />
                    <Button
                      variant="ghost"
                      startIcon={member.blocked ? <ShieldCheck /> : <Ban />}
                      title={t(
                        member.blocked ? 'Разблокировать' : 'Заблокировать',
                      )}
                      aria-label={t(
                        member.blocked
                          ? 'Разблокировать: {name}'
                          : 'Заблокировать: {name}',
                        {name: member.name},
                      )}
                      disabled={busy}
                      onClick={() =>
                        void action(
                          member,
                          member.blocked ? 'unblock' : 'block',
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      startIcon={<BellRing />}
                      className={calls[member.id] ? styles.alert : ''}
                      title={t('Вызов')}
                      aria-label={t('Вызов: {name}', {name: member.name})}
                      disabled={busy}
                      onClick={() => void action(member, 'call')}
                    />
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Pagination
        label={t('Страницы регистраций')}
        page={cursors.length}
        hasNext={Boolean(next)}
        busy={loading || busy}
        onPrevious={() => setCursors((x) => x.slice(0, -1))}
        onNext={() => {
          if (next) setCursors((x) => [...x, next]);
        }}
      />
      {qr && (
        <LinkQrDialog
          roomId={roomId}
          linkId={group.id}
          name={qr.name}
          sourcePath={`${base}/${qr.id}/qr`}
          onClose={() => setQr(null)}
        />
      )}
    </Panel>
  );
}
