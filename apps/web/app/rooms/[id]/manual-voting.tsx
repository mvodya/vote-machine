'use client';
import {useEffect, useState} from 'react';
import {ArrowRight} from 'lucide-react';
import {AnswerForm} from '../../vote/[id]/answer-form';
import {SelectField} from '../../../components/ui/select-field';
import {Button} from '../../../components/ui/button';
import {isQuestion, type Question} from '../../../lib/questions';
import type {VotingLink} from '../../../lib/voting-links';
// Reuse the same ballot controls for manual and personal-right entry
function ManualVotingForm({
  roomId,
  questionId,
  onDenied,
  timeZone,
}: {
  roomId: string;
  questionId: string;
  onDenied: () => void;
  timeZone: string;
}) {
  const [linkId, setLinkId] = useState('');
  const [links, setLinks] = useState<VotingLink[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [context, setContext] = useState<{
    question: Question;
    answered: boolean;
    answerRevision: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const path = `/api/rooms/${roomId}/questions/${questionId}/manual`;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(
          `${path}${linkId ? `?linkId=${linkId}` : ''}`,
          {cache: 'no-store', signal: controller.signal},
        );
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (!response.ok || !isQuestion(data.question)) throw new Error();
        setContext(data);
      } catch {
        if (!controller.signal.aborted)
          setError('Не удалось открыть ручной ввод');
      }
    }
    void load();
    return () => controller.abort();
  }, [path, linkId, attempt, onDenied]);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(`/api/rooms/${roomId}/links`, {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        const data = await response.json();
        if (response.ok) {
          setLinks(data.links);
          setNext(data.nextCursor);
        }
      } catch {}
    }
    void load();
    return () => controller.abort();
  }, [roomId, onDenied]);
  // Additional pages keep large respondent lists usable
  async function more() {
    if (!next) return;
    try {
      const response = await fetch(`/api/rooms/${roomId}/links?after=${next}`, {
        cache: 'no-store',
      });
      if (response.status === 401) {
        onDenied();
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error();
      setLinks((old) => [...old, ...data.links]);
      setNext(data.nextCursor);
    } catch {
      setError('Не удалось загрузить респондентов');
    }
  }
  return (
    <section
      aria-label="Ручное голосование"
      className="space-y-4 border-t border-border pt-5"
    >
      <h3 className="font-medium">Ручное голосование</h3>
      {saved ? (
        <>
          <p role="status" className="text-sm text-success-ink">
            Голос сохранен
          </p>
          <Button
            startIcon={<ArrowRight />}
            onClick={() => {
              setSaved(false);
              setLinkId('');
              setAttempt((value) => value + 1);
            }}
          >
            Следующий голосующий
          </Button>
        </>
      ) : (
        <>
          <SelectField
            id="manual-source"
            label="Источник голоса"
            value={linkId}
            disabled={busy}
            onChange={(event) => {
              setLinkId(event.target.value);
              setContext(null);
              setError('');
            }}
          >
            <option value="">Новый ручной голос</option>
            {links
              .filter((link) => link.mode === 'personal' && !link.revoked)
              .map((link) => (
                <option key={link.id} value={link.id}>
                  {link.name}
                </option>
              ))}
          </SelectField>
          {next && (
            <Button variant="ghost" onClick={() => void more()}>
              Еще респонденты
            </Button>
          )}
          {context && (
            <AnswerForm
              key={`${linkId}/${context.question.revision}/${context.answerRevision}/${attempt}`}
              linkId={linkId || roomId}
              timeZone={timeZone}
              question={context.question}
              answer={null}
              alreadyAnswered={context.answered}
              existingRevision={context.answerRevision}
              submitPath={path}
              extraPayload={linkId ? {linkId} : undefined}
              onBusy={setBusy}
              onSaved={() => setSaved(true)}
              onDenied={onDenied}
              onSkip={() => {}}
              onRefresh={(notice) => {
                setError(notice);
                setAttempt((value) => value + 1);
              }}
            />
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-ink">
          {error}
        </p>
      )}
    </section>
  );
}

// Open manual entry only when the admin asks for it
export function ManualVoting(props: Parameters<typeof ManualVotingForm>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-5">
      <Button variant="secondary" onClick={() => setOpen((value) => !value)}>
        {open ? 'Скрыть ручной ввод' : 'Ввести голос вручную'}
      </Button>
      {open && <ManualVotingForm {...props} />}
    </div>
  );
}
