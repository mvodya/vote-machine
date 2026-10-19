'use client';

import {useLive} from '../../../lib/use-live';
import {useEffect, useState, type FormEvent} from 'react';
import {
  Copy,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Ban,
  Users,
} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {Pagination} from '../../../components/ui/pagination';
import {Panel} from '../../../components/ui/panel';
import {SectionHeader} from '../../../components/ui/section-header';
import {EmptyState} from '../../../components/ui/empty-state';
import {Form} from '../../../components/ui/form';
import {TextField} from '../../../components/ui/text-field';
import {TextareaField} from '../../../components/ui/textarea-field';
import {SelectField} from '../../../components/ui/select-field';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {
  isVotingLink,
  validCursor,
  linksCsv,
  linksText,
  votingUrl,
  type VotingLink,
  type LinkMode,
  type ExportLink,
} from '../../../lib/voting-links';
import {secretPattern} from '../../../lib/rooms';

type Confirmation = {
  // Link chosen by the admin
  link: VotingLink;
  // Action shown in the dialog
  action: 'revoke' | 'rotate';
};

// Manage links without loading any voting data
export function Respondents({
  roomId,
  onDenied,
}: {
  // Current admin room
  roomId: string;
  // Leave the panel when access is lost
  onDenied: () => void;
}) {
  // Links on the current page
  const [links, setLinks] = useState<VotingLink[]>([]);
  // Page history for back navigation
  const [cursors, setCursors] = useState(['0']);
  // Cursor for the next older page
  const [next, setNext] = useState<string | null>(null);
  // Reload counter
  const [attempt, setAttempt] = useState(0);
  // Whether a page request is running
  const [loading, setLoading] = useState(true);
  // Whether the last page request failed
  const [failed, setFailed] = useState(false);
  // Block repeated actions while a request is running
  const [busy, setBusy] = useState(false);
  // Whether the create form is open
  const [adding, setAdding] = useState(false);
  // Single name or a batch of names
  const [batch, setBatch] = useState(false);
  // Mode for the new links
  const [mode, setMode] = useState<LinkMode>('personal');
  // Name for one new link
  const [name, setName] = useState('');
  // Names pasted as separate lines
  const [names, setNames] = useState('');
  // Batch size when no names are given
  const [count, setCount] = useState('10');
  // Link being renamed
  const [editing, setEditing] = useState<string | null>(null);
  // New name for the selected link
  const [editName, setEditName] = useState('');
  // Pending action that needs confirmation
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  // Short result or error message
  const [notice, setNotice] = useState('');
  // Text shown when clipboard access fails
  const [manualCopy, setManualCopy] = useState('');
  const cursor = cursors[cursors.length - 1];
  const live = useLive(`/api/rooms/${roomId}/events`, onDenied);
  const base = `/api/rooms/${roomId}/links`;

  useEffect(() => {
    const controller = new AbortController();
    // Cancel old page requests when the panel or cursor changes
    async function load() {
      await Promise.resolve();
      if (controller.signal.aborted) return;

      setFailed(false);
      try {
        const response = await fetch(`${base}?after=${cursor}`, {
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(12000),
          ]),
        });
        // Stop when this room session has no access
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (!response.ok) throw new Error('Load failed');
        const body = await response.json();
        if (
          !Array.isArray(body.links) ||
          !body.links.every(isVotingLink) ||
          (body.nextCursor !== null && !validCursor(body.nextCursor))
        )
          throw new Error('Bad page');
        if (!controller.signal.aborted) {
          setLinks(body.links);
          setNext(body.nextCursor);
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [base, cursor, attempt, onDenied, live.version]);

  // Refresh the page after a saved change
  function reload() {
    setAttempt((value) => value + 1);
  }

  // Keep all writes on the same checked path
  async function write(path: string, method: string, body: unknown) {
    const response = await fetch(path, {
      method,
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (response.status === 401) {
      onDenied();
      throw new Error('Access lost');
    }
    if (!response.ok) throw new Error('Write failed');
  }

  // Send the whole batch so one bad name cannot save half of it
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Do not send the same action twice
    if (busy) return;
    const entered = names
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    const amount = Number(count);
    if (
      batch &&
      !entered.length &&
      (!Number.isInteger(amount) || amount < 1 || amount > 100)
    ) {
      setNotice('Укажите количество от 1 до 100');
      return;
    }
    const values = batch
      ? entered.length
        ? entered
        : Array.from({length: amount}, (_, index) => `Респондент ${index + 1}`)
      : [name.trim() || 'Респондент'];
    if (
      values.length > 100 ||
      values.some((value) => [...value].length > 200 || value.includes('\0'))
    ) {
      setNotice('Не более 100 имен, до 200 символов каждое');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      await write(base, 'POST', {mode, names: values});
      setAdding(false);
      setName('');
      setNames('');
      setCursors(['0']);
      reload();
      setNotice(
        values.length === 1 ? 'Респондент добавлен' : 'Респонденты добавлены',
      );
    } catch {
      setNotice('Не удалось создать ссылки, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }

  // Save a label without changing the link or its mode
  async function rename(event: FormEvent<HTMLFormElement>, link: VotingLink) {
    event.preventDefault();
    // Do not send the same action twice
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await write(`${base}/${link.id}`, 'PATCH', {
        action: 'rename',
        name: editName.trim() || 'Респондент',
      });
      setEditing(null);
      reload();
    } catch {
      setNotice('Не удалось сохранить имя');
    } finally {
      setBusy(false);
    }
  }

  // Apply only the action confirmed in the open dialog
  async function confirm() {
    if (!confirmation || busy) return;
    setBusy(true);
    setNotice('');
    try {
      await write(`${base}/${confirmation.link.id}`, 'PATCH', {
        action: confirmation.action,
      });
      setNotice(
        confirmation.action === 'revoke'
          ? 'Ссылка отозвана'
          : 'Ссылка перевыпущена',
      );
      setConfirmation(null);
      setManualCopy('');
      reload();
    } catch {
      setNotice('Не удалось изменить ссылку');
    } finally {
      setBusy(false);
    }
  }

  // Let the user copy by hand if clipboard access is blocked
  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setManualCopy('');
      setNotice('Скопировано');
    } catch {
      setManualCopy(value);
      setNotice('Выделите текст и скопируйте вручную');
    }
  }

  // Read the current key only when the admin asks for it
  async function copyLink(link: VotingLink) {
    // Do not send the same action twice
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const response = await fetch(`${base}/${link.id}/secret`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(12000),
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      if (!response.ok) throw new Error('Link unavailable');
      const body = await response.json();
      if (!secretPattern.test(body.token ?? '')) throw new Error('Bad key');
      await copyText(votingUrl(window.location.origin, link.id, body.token));
    } catch {
      setNotice('Не удалось получить ссылку, обновите список');
    } finally {
      setBusy(false);
    }
  }

  // Read every page only for an explicit copy or export request
  async function exportLinks(csv: boolean) {
    // Do not send the same action twice
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      const all: ExportLink[] = [];
      let after = '0';
      do {
        const response = await fetch(`${base}?export=1&after=${after}`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(12000),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (!response.ok) throw new Error('Export failed');
        const body = await response.json();
        if (
          !Array.isArray(body.links) ||
          !body.links.every(
            (link: ExportLink) =>
              isVotingLink(link) &&
              (link.revoked
                ? link.token === null
                : typeof link.token === 'string' &&
                  secretPattern.test(link.token)),
          )
        )
          throw new Error('Bad export');
        all.push(...body.links);
        if (body.nextCursor === null) break;
        // A cursor must move backwards to avoid a broken export loop
        if (
          !validCursor(body.nextCursor) ||
          body.nextCursor === '0' ||
          (after !== '0' && BigInt(body.nextCursor) >= BigInt(after))
        )
          throw new Error('Bad cursor');
        after = body.nextCursor;
      } while (true);
      if (csv) {
        const url = URL.createObjectURL(
          new Blob([linksCsv(all, window.location.origin)], {
            type: 'text/csv;charset=utf-8',
          }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'respondents.csv';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('CSV сохранен');
      } else {
        await copyText(linksText(all, window.location.origin));
      }
    } catch {
      setNotice('Не удалось выгрузить ссылки, попробуйте снова');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel>
      <SectionHeader title="Респонденты">
        <Button
          disabled={busy}
          onClick={() => setAdding((value) => !value)}
          startIcon={<Plus />}
        >
          Добавить респондентов
        </Button>
      </SectionHeader>
      {adding && (
        <div className="mt-5 mb-6 rounded-xl border border-border bg-page p-4 sm:p-5">
          <div
            className="mb-5 flex rounded-xl bg-ink/5 p-1"
            aria-label="Способ добавления"
          >
            <Button
              variant="switch"
              aria-pressed={!batch}
              onClick={() => setBatch(false)}
            >
              Один
            </Button>
            <Button
              variant="switch"
              aria-pressed={batch}
              onClick={() => setBatch(true)}
            >
              Списком
            </Button>
          </div>
          <Form onSubmit={(event) => void create(event)}>
            <SelectField
              id="link-mode"
              label="Режим ссылки"
              value={mode}
              onChange={(event) => setMode(event.target.value as LinkMode)}
            >
              <option value="personal">Персональная</option>
              <option value="reusable">Многоразовая</option>
            </SelectField>
            {batch ? (
              <>
                <TextareaField
                  id="link-names"
                  label="Имена, по одному на строку"
                  hint="Если имена не указаны, будут созданы нумерованные респонденты"
                  value={names}
                  onChange={(event) => setNames(event.target.value)}
                />
                <TextField
                  id="link-count"
                  label="Количество без списка имен"
                  type="number"
                  min={1}
                  max={100}
                  disabled={Boolean(names.trim())}
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                />
              </>
            ) : (
              <TextField
                id="link-name"
                label="Имя респондента"
                hint="Можно оставить пустым"
                maxLength={200}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            <div className="flex flex-wrap gap-3">
              <Button type="submit" disabled={busy}>
                {busy ? 'Создаем…' : 'Создать ссылки'}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => setAdding(false)}
              >
                Отмена
              </Button>
            </div>
          </Form>
        </div>
      )}
      <div className="mt-5 mb-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={busy || loading}
          startIcon={<Copy />}
          onClick={() => void exportLinks(false)}
        >
          Скопировать список
        </Button>
        <Button
          variant="secondary"
          disabled={busy || loading}
          startIcon={<Download />}
          onClick={() => void exportLinks(true)}
        >
          Скачать CSV
        </Button>
      </div>
      {loading ? (
        <p role="status" className="py-8 text-muted">
          Загружаем респондентов…
        </p>
      ) : failed ? (
        <div role="alert" className="py-8">
          <p>Не удалось загрузить список</p>
          <Button className="mt-3" onClick={reload}>
            Попробовать снова
          </Button>
        </div>
      ) : links.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title="Респондентов пока нет"
          description="Добавьте респондентов для получения ссылок"
        />
      ) : (
        <ul className="divide-y divide-border">
          {links.map((link) => (
            <li
              key={link.id}
              className="py-5 first:pt-2"
              aria-label={link.name}
            >
              {editing === link.id ? (
                <Form onSubmit={(event) => void rename(event, link)}>
                  <TextField
                    id={`name-${link.id}`}
                    label="Имя респондента"
                    maxLength={200}
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  <div className="flex gap-2">
                    <Button type="submit" disabled={busy}>
                      Сохранить имя
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => setEditing(null)}
                    >
                      Отмена
                    </Button>
                  </div>
                </Form>
              ) : (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <h3 className="font-medium break-words">{link.name}</h3>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                      <span>
                        {link.mode === 'personal'
                          ? 'Персональная'
                          : 'Многоразовая'}
                      </span>
                      <span
                        className={
                          link.revoked ? 'text-red-700' : 'text-green-800'
                        }
                      >
                        {link.revoked ? 'Отозвана' : 'Действует'}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1">
                    {!link.revoked && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        startIcon={<Copy />}
                        onClick={() => void copyLink(link)}
                      >
                        Скопировать ссылку
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      title="Изменить имя"
                      aria-label={`Изменить имя: ${link.name}`}
                      disabled={busy}
                      startIcon={<Pencil />}
                      onClick={() => {
                        setEditing(link.id);
                        setEditName(link.name);
                      }}
                    />
                    <Button
                      variant="ghost"
                      title="Перевыпустить ссылку"
                      aria-label={`Перевыпустить ссылку: ${link.name}`}
                      disabled={busy}
                      startIcon={<RefreshCw />}
                      onClick={() => {
                        setNotice('');
                        setConfirmation({link, action: 'rotate'});
                      }}
                    />
                    {!link.revoked && (
                      <Button
                        variant="ghost"
                        title="Отозвать ссылку"
                        aria-label={`Отозвать ссылку: ${link.name}`}
                        disabled={busy}
                        startIcon={<Ban />}
                        onClick={() => {
                          setNotice('');
                          setConfirmation({link, action: 'revoke'});
                        }}
                      />
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {!loading && !failed && (
        <Pagination
          label="Страницы респондентов"
          page={cursors.length}
          hasNext={Boolean(next)}
          busy={busy}
          onPrevious={() => setCursors((value) => value.slice(0, -1))}
          onNext={() => next && setCursors((value) => [...value, next])}
        />
      )}
      <p role="status" className="mt-4 text-sm text-muted">
        {notice}
      </p>
      {manualCopy && (
        <TextareaField
          id="copy-links"
          className="mt-4 font-mono text-xs"
          label="Текст для копирования"
          value={manualCopy}
          readOnly
          onFocus={(event) => event.target.select()}
        />
      )}
      {confirmation && (
        <ConfirmDialog
          title={
            confirmation.action === 'revoke'
              ? 'Отозвать ссылку?'
              : 'Перевыпустить ссылку?'
          }
          description={
            confirmation.action === 'revoke'
              ? 'Ссылка и открытые по ней сессии перестанут работать'
              : 'Старая ссылка и ее сессии перестанут работать, имя и использованное право голоса сохранятся'
          }
          confirmLabel={
            confirmation.action === 'revoke' ? 'Отозвать' : 'Перевыпустить'
          }
          busy={busy}
          error={notice}
          onConfirm={() => void confirm()}
          onClose={() => setConfirmation(null)}
        />
      )}
    </Panel>
  );
}
