'use client';
import {useRef, useState} from 'react';
import {Check} from 'lucide-react';
import {Button} from '../../../components/ui/button';
import {TextField} from '../../../components/ui/text-field';
import {Form} from '../../../components/ui/form';
import {isRoom, type Room} from '../../../lib/rooms';

// Save the room name on blur or with the field action
export function RoomName({
  room,
  onSaved,
  onDenied,
  onNotice,
}: {
  // Last saved room data
  room: Room;
  // Update the room heading after a successful save
  onSaved: (value: Room) => void;
  // Leave settings when access is lost
  onDenied: () => void;
  // Show a short save result
  onNotice: (value: string) => void;
}) {
  // Text currently shown in the field
  const [name, setName] = useState(room.name);
  // Whether a name request is running
  const [saving, setSaving] = useState(false);
  // Latest text, including edits made during a request
  const current = useRef(name);
  // Guard blur and click events in the same frame
  const running = useRef(false);
  // Save a newer blur after the current request finishes
  const pending = useRef(false);

  // Keep newer local text when an older save returns
  async function save() {
    if (running.current) {
      pending.current = true;
      return;
    }
    if (current.current === room.name) return;
    running.current = true;
    setSaving(true);
    onNotice('');
    let savedName = room.name;
    try {
      do {
        pending.current = false;
        const submitted = current.current;
        if (submitted === savedName) break;
        const response = await fetch(`/api/rooms/${room.id}`, {
          method: 'PATCH',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({name: submitted}),
          signal: AbortSignal.timeout(12000),
        });
        if (response.status === 401) {
          onDenied();
          return;
        }
        if (!response.ok) throw new Error('Save failed');
        const body = await response.json();
        if (!isRoom(body.room) || body.room.id !== room.id)
          throw new Error('Invalid room');
        savedName = body.room.name;
        onSaved(body.room);
        // A response must not replace text typed while it was loading
        if (current.current === submitted) {
          current.current = savedName;
          setName(savedName);
        }
        onNotice('Название сохранено');
      } while (pending.current);
    } catch {
      onNotice('Не удалось сохранить название, попробуйте снова');
    } finally {
      running.current = false;
      setSaving(false);
    }
  }
  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField
        id="edit-name"
        label="Название комнаты"
        value={name}
        maxLength={200}
        onChange={(event) => {
          current.current = event.target.value;
          setName(event.target.value);
          onNotice('');
        }}
        onBlur={() => void save()}
        endAction={
          name !== room.name || saving ? (
            <Button
              variant="ghost"
              aria-label="Сохранить название"
              title="Сохранить название"
              disabled={saving}
              startIcon={<Check />}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void save()}
            />
          ) : undefined
        }
      />
    </Form>
  );
}
