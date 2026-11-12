'use client';

import {useEffect, useRef, useState} from 'react';
import {Copy, Eye, EyeOff, RefreshCw} from 'lucide-react';
import {useI18n} from '../../../components/language-provider';
import {Panel} from '../../../components/ui/panel';
import {Button} from '../../../components/ui/button';
import {ConfirmDialog} from '../../../components/ui/confirm-dialog';
import {TextField} from '../../../components/ui/text-field';
import {secretPattern} from '../../../lib/rooms';

// Read the saved token or replace it after confirmation
async function loadToken(
  path: string,
  method: 'POST' | 'PUT',
  signal: AbortSignal,
) {
  const response = await fetch(path, {method, cache: 'no-store', signal});
  if (response.status === 401) return null;
  if (!response.ok) throw new Error();
  const {token} = await response.json();
  if (typeof token !== 'string' || !secretPattern.test(token))
    throw new Error();
  return token;
}

// Show the public endpoint and keep the room token masked by default
export function McpSettings({
  roomId,
  onDenied,
}: {
  roomId: string;
  onDenied: () => void;
}) {
  const {t} = useI18n();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const rotateButton = useRef<HTMLButtonElement>(null);
  const path = `/api/rooms/${roomId}/mcp`;

  useEffect(() => {
    const controller = new AbortController();
    void loadToken(
      path,
      'POST',
      AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    )
      .then((value) => {
        if (controller.signal.aborted) return;
        setUrl(`${location.origin}/api/mcp`);
        if (value === null) return onDenied();
        setToken(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setUrl(`${location.origin}/api/mcp`);
          setError('Не удалось загрузить API-токен');
        }
      });
    return () => controller.abort();
  }, [path, attempt, onDenied]);

  // Copy the requested value without revealing it in the field
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(label);
    } catch {
      setNotice('Скопируйте значение из поля');
    }
  }

  // Hide the new value and replace the old one only after the server confirms
  async function rotate() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await loadToken(path, 'PUT', AbortSignal.timeout(10000));
      if (value === null) return onDenied();
      setToken(value);
      setVisible(false);
      setConfirm(false);
      setNotice('API-токен обновлен');
    } catch {
      setError('Не удалось обновить API-токен');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel aria-label={t('MCP и API')}>
      <h2 className="mb-3 text-lg font-semibold">{t('MCP и API')}</h2>
      <TextField
        id="mcp-endpoint"
        label={t('MCP-ссылка')}
        hint={t('Добавьте эту ссылку в MCP-клиент')}
        value={url}
        readOnly
        onFocus={(event) => event.target.select()}
        endAction={
          <Button
            variant="ghost"
            aria-label={t('Скопировать MCP-ссылку')}
            startIcon={<Copy />}
            disabled={!url}
            onClick={() => void copy(url, 'Ссылка скопирована')}
          />
        }
      />
      <div className="mt-4">
        <TextField
          id="room-api-token"
          label={t('API-токен комнаты')}
          hint={t(
            'Токен дает административный доступ к комнате через MCP и API',
          )}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          className="pr-32 font-mono"
          value={token}
          readOnly
          onClick={() => {
            if (token) setVisible(true);
          }}
          onFocus={(event) => {
            if (visible) event.target.select();
          }}
          endAction={
            <div className="flex">
              <Button
                variant="ghost"
                aria-label={t(
                  visible ? 'Скрыть API-токен' : 'Показать API-токен',
                )}
                startIcon={visible ? <EyeOff /> : <Eye />}
                disabled={!token}
                onClick={() => setVisible((value) => !value)}
              />
              <Button
                variant="ghost"
                aria-label={t('Скопировать API-токен')}
                startIcon={<Copy />}
                disabled={!token}
                onClick={() => void copy(token, 'API-токен скопирован')}
              />
              <Button
                ref={rotateButton}
                variant="ghost"
                aria-label={t('Обновить API-токен')}
                title={t('Обновить API-токен')}
                startIcon={<RefreshCw />}
                disabled={!token || busy}
                onClick={() => {
                  setError('');
                  setConfirm(true);
                }}
              />
            </div>
          }
        />
      </div>
      {!token && error && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-error-ink">
            {t(error)}
          </p>
          <Button
            variant="ghost"
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            {t('Повторить попытку')}
          </Button>
        </div>
      )}
      {notice && (
        <p role="status" className="mt-3 text-xs text-muted">
          {t(notice)}
        </p>
      )}
      {confirm && (
        <ConfirmDialog
          title={t('Обновить API-токен?')}
          description={t('Старый токен сразу перестанет работать в MCP и API')}
          confirmLabel="Обновить API-токен"
          busy={busy}
          error={error}
          returnFocusRef={rotateButton}
          onConfirm={() => void rotate()}
          onClose={() => setConfirm(false)}
        />
      )}
    </Panel>
  );
}
