'use client';
import {useI18n} from '../language-provider';
import {SegmentedControl} from './segmented-control';
import {Spinner} from './loading';
import {useEffect, useRef, useState} from 'react';
import {
  TextCursorInput,
  Eye,
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  Quote,
  Code,
  Paperclip,
} from 'lucide-react';
import {Help} from './help';
import {Button} from './button';
import {TextareaField} from './textarea-field';
import {Markdown} from '../markdown';
import {acceptedMedia, maxUploadBytes, assetId} from '../../lib/assets';
// Reuse source editing, safe preview and private uploads for every text field
export function MarkdownField({
  id,
  label,
  hint,
  value,
  onChange,
  roomId,
  rows = 3,
  onUploadChange,
  readOnly = false,
}: {
  // Field and label ID
  id: string;
  // Visible field label
  label: string;
  // Size or content hint
  hint?: string;
  // Current Markdown source
  value: string;
  // Replace the source after an edit
  onChange: (value: string) => void;
  // Owner used for all upload and preview requests
  roomId: string;
  // Show rendered content for a locked question
  readOnly?: boolean;
  // Initial text area height
  rows?: number;
  // Track active uploads so the editor cannot save a partial upload
  onUploadChange: (delta: number) => void;
}) {
  const {t} = useI18n();
  // Text or rendered preview
  const [preview, setPreview] = useState(readOnly);
  // Whether this field has an upload in progress
  const [uploading, setUploading] = useState(false);
  // Short upload error
  const [error, setError] = useState('');
  // Text selection used by the toolbar
  const area = useRef<HTMLTextAreaElement>(null);
  // Native file picker
  const picker = useRef<HTMLInputElement>(null);
  // Latest source and callback while a file is being processed
  const text = useRef(value);
  const change = useRef(onChange);
  // Ignore results for a removed option
  const active = useRef(true);
  useEffect(() => {
    text.current = value;
    change.current = onChange;
  }, [value, onChange]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // Insert at the current caret without overwriting newer text
  function insert(before: string, after = '', fallback = '') {
    const source = area.current?.value ?? text.current;
    const start = area.current?.selectionStart ?? source.length;
    const end = area.current?.selectionEnd ?? start;
    const selected = source.slice(start, end) || fallback;
    const next =
      source.slice(0, start) + before + selected + after + source.slice(end);
    text.current = next;
    change.current(next);
    setPreview(false);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(
        start + before.length,
        start + before.length + selected.length,
      );
    });
  }
  // Keep the pending upload separate from the saved question
  async function upload(file: File) {
    if (uploading) return;
    if (file.size > maxUploadBytes) {
      setError('Не более 10 MiB на файл');
      return;
    }
    setUploading(true);
    setError('');
    onUploadChange(1);
    try {
      const form = new FormData();
      form.set('file', file);
      const response = await fetch(`/api/rooms/${roomId}/assets`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(300000),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          typeof body.error === 'string'
            ? body.error
            : 'Не удалось загрузить файл',
        );
      if (typeof body.id !== 'string' || assetId(body.source) !== body.id)
        throw new Error('Не удалось загрузить файл');
      if (active.current)
        insert(
          `![${body.kind === 'video' ? t('Видео') : t('Изображение')}](${body.source})`,
        );
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Не удалось загрузить файл',
        );
    } finally {
      if (active.current) setUploading(false);
      onUploadChange(-1);
    }
  }
  return (
    <div className="min-w-0">
      {!readOnly && (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SegmentedControl
              label={t('Режим редактора: {value0}', {value0: label})}
              value={preview ? 'preview' : 'text'}
              className="inline-flex"
              items={[
                {
                  id: 'text',
                  label: t('Текст'),
                  icon: <TextCursorInput />,
                },
                {
                  id: 'preview',
                  label: t('Предпросмотр'),
                  icon: <Eye />,
                },
              ]}
              onChange={(next) => setPreview(next === 'preview')}
            />
            <div
              role="toolbar"
              aria-label={t('Форматирование: {value0}', {value0: label})}
              className="flex flex-wrap items-center gap-0.5"
            >
              <Help label={label} align="start">
                <span className="block">{hint}</span>
                <span className="mt-2 block">{t('Размер изображения')}</span>
                <code className="mt-1 block whitespace-pre-wrap break-normal">
                  {t('![Описание](asset:ID\n  "width=320")')}
                </code>
              </Help>
              <Button
                variant="ghost"
                title={t('Жирный текст')}
                aria-label={t('Жирный текст: {value0}', {value0: label})}
                startIcon={<Bold />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert('**', '**', t('текст'))}
              />
              <Button
                variant="ghost"
                title={t('Курсив')}
                aria-label={t('Курсив: {value0}', {value0: label})}
                startIcon={<Italic />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert('*', '*', t('текст'))}
              />
              <Button
                variant="ghost"
                title={t('Ссылка')}
                aria-label={t('Ссылка: {value0}', {value0: label})}
                startIcon={<LinkIcon />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() =>
                  insert('[', '](https://example.com)', t('ссылка'))
                }
              />
              <Button
                variant="ghost"
                title={t('Список')}
                aria-label={t('Список: {value0}', {value0: label})}
                startIcon={<List />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert('\n- ', '', t('пункт'))}
              />
              <Button
                variant="ghost"
                title={t('Цитата')}
                aria-label={t('Цитата: {value0}', {value0: label})}
                startIcon={<Quote />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert('\n> ', '', t('цитата'))}
              />
              <Button
                variant="ghost"
                title={t('Код')}
                aria-label={t('Код: {value0}', {value0: label})}
                startIcon={<Code />}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insert('`', '`', t('код'))}
              />
              <Button
                variant="ghost"
                title={t('Добавить файл')}
                aria-label={t('Добавить файл: {value0}', {value0: label})}
                disabled={uploading}
                startIcon={<Paperclip />}
                onClick={() => picker.current?.click()}
              />
            </div>
          </div>
        </>
      )}
      <input
        ref={picker}
        hidden
        type="file"
        accept={acceptedMedia}
        aria-label={t('Файл для {value0}', {
          value0: label,
        })}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />
      {readOnly || preview ? (
        <section
          aria-label={t('Предпросмотр: {value0}', {value0: label})}
          className="min-h-28 rounded-xl border border-border bg-panel px-4 py-2"
        >
          <Markdown source={value} viewer={{roomId}} />
        </section>
      ) : (
        <TextareaField
          ref={area}
          id={id}
          label={label}
          value={value}
          rows={rows}
          onChange={(event) => {
            text.current = event.target.value;
            onChange(event.target.value);
          }}
        />
      )}
      {uploading && <Spinner label={t('Загружаем и проверяем файл…')} />}
      {error && (
        <p role="alert" className="mt-2 text-sm text-error-ink">
          {t(error)}
        </p>
      )}
    </div>
  );
}
