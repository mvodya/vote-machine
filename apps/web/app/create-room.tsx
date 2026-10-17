'use client';

import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useRouter} from 'next/navigation';
import {isRoom, secretPattern} from '../lib/rooms';
import {ArrowUpRight} from 'lucide-react';
import {Button} from '../components/ui/button';
import {TextField} from '../components/ui/text-field';
import {Form} from '../components/ui/form';

// Show the form for a new room
export default function CreateRoom() {
  const router = useRouter();
  // Name typed in the form
  const [name, setName] = useState('');
  // Whether a create request is running
  const [busy, setBusy] = useState(false);
  // Whether the last request failed
  const [error, setError] = useState(false);
  // Request to stop when the form closes
  const pending = useRef<AbortController | null>(null);
  // Stop late replies when the user leaves the form
  useEffect(() => () => pending.current?.abort(), []);

  // Create the room and open its admin link
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Ignore a second click while the request runs
    if (busy) return;
    setBusy(true);
    setError(false);
    const controller = new AbortController();
    pending.current = controller;
    try {
      // Cancel on form exit or after the time limit
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name}),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(12000),
        ]),
      });
      if (!response.ok) throw new Error('Create failed');
      const body = await response.json();
      // Only open a room with valid data and a link key
      if (
        !isRoom(body.room) ||
        typeof body.adminToken !== 'string' ||
        !secretPattern.test(body.adminToken)
      )
        throw new Error('Invalid room');
      // A closed form must not open a new page
      if (controller.signal.aborted) return;
      router.push(`/rooms/${body.room.id}#admin=${body.adminToken}`);
    } catch {
      // A closed form must not open a new page
      if (controller.signal.aborted) return;
      setError(true);
      setBusy(false);
    }
  }

  return (
    <Form onSubmit={(event) => void create(event)}>
      <TextField
        id="room-name"
        label="Название комнаты"
        value={name}
        maxLength={200}
        placeholder="Например, встреча команды"
        hint="Можно оставить пустым и изменить позже"
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        type="submit"
        fullWidth
        disabled={busy}
        endIcon={<ArrowUpRight size={20} />}
      >
        {busy ? 'Создаем…' : 'Создать комнату'}
      </Button>
      {error && (
        <p role="alert" className="mt-4 text-sm text-error-ink">
          Не удалось создать комнату, попробуйте снова
        </p>
      )}
    </Form>
  );
}
