import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {useState} from 'react';
import {expect, it, vi} from 'vitest';
import {RoomName} from '../app/rooms/[id]/room-name';
import {QuestionPolicy} from '../app/rooms/[id]/question-policy';

const room = {
  id: 'a96c3a49-0198-4545-8dce-44b70c86494d',
  name: 'Original',
  createdAt: '2026-10-25T00:00:00Z',
  revision: '0',
};
// Keep parent data in sync as the real room page does
function NameForm() {
  const [value, setValue] = useState(room);
  return (
    <RoomName
      room={value}
      onSaved={setValue}
      onDenied={vi.fn()}
      onNotice={vi.fn()}
    />
  );
}
// Return a saved name without using a real API
function renamed(name: string) {
  return Response.json({room: {...room, name}});
}
// Return the room rule and its version
function policy(lockAfterOpen: boolean, revision = '0') {
  return Response.json({policy: {lockAfterOpen, revision}});
}

it('saves a changed name on blur and hides the inline action after saving', async () => {
  const fetcher = vi.fn().mockResolvedValue(renamed('New name'));
  vi.stubGlobal('fetch', fetcher);
  render(<NameForm />);
  const input = screen.getByLabelText('Название комнаты');
  fireEvent.blur(input);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(input, {target: {value: 'New name'}});
  expect(
    screen.getByRole('button', {name: 'Сохранить название'}),
  ).toBeVisible();
  fireEvent.blur(input);
  await waitFor(() =>
    expect(
      screen.queryByRole('button', {name: 'Сохранить название'}),
    ).not.toBeInTheDocument(),
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({name: 'New name'});
});
it('serializes two blurred edits and keeps new text while an old save finishes', async () => {
  let finishFirst!: (value: Response) => void;
  let finishSecond!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishSecond = resolve;
        }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<NameForm />);
  const input = screen.getByLabelText('Название комнаты');
  fireEvent.change(input, {target: {value: 'First'}});
  fireEvent.click(screen.getByRole('button', {name: 'Сохранить название'}));
  fireEvent.change(input, {target: {value: 'Second'}});
  fireEvent.blur(input);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => finishFirst(renamed('First')));
  expect(input).toHaveValue('Second');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({name: 'Second'});
  await act(async () => finishSecond(renamed('Second')));
  expect(input).toHaveValue('Second');
  expect(
    screen.queryByRole('button', {name: 'Сохранить название'}),
  ).not.toBeInTheDocument();
});
it('keeps an unsaved name after a failed request so the check can retry', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, {status: 503}))
    .mockResolvedValueOnce(renamed('Retry'));
  vi.stubGlobal('fetch', fetcher);
  render(<NameForm />);
  const input = screen.getByLabelText('Название комнаты');
  fireEvent.change(input, {target: {value: 'Retry'}});
  fireEvent.blur(input);
  await waitFor(() =>
    expect(
      screen.getByRole('button', {name: 'Сохранить название'}),
    ).toBeEnabled(),
  );
  expect(input).toHaveValue('Retry');
  fireEvent.click(screen.getByRole('button', {name: 'Сохранить название'}));
  await waitFor(() =>
    expect(
      screen.queryByRole('button', {name: 'Сохранить название'}),
    ).not.toBeInTheDocument(),
  );
});
it('saves a checkbox change automatically and refreshes a stale room version', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(policy(true))
    .mockResolvedValueOnce(Response.json({error: 'conflict'}, {status: 409}))
    .mockResolvedValueOnce(policy(true, '2'))
    .mockResolvedValueOnce(policy(false, '3'));
  vi.stubGlobal('fetch', fetcher);
  render(<QuestionPolicy roomId={room.id} onDenied={vi.fn()} />);
  const input = screen.getByRole('checkbox');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.click(input);
  await screen.findByText('Правило сохранено');
  expect(input).not.toBeChecked();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual({
    lockAfterOpen: false,
    revision: '2',
  });
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('restores the saved checkbox after a failure and allows retry by toggling', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(policy(true))
    .mockResolvedValueOnce(new Response(null, {status: 503}))
    .mockResolvedValueOnce(policy(false, '1'));
  vi.stubGlobal('fetch', fetcher);
  render(<QuestionPolicy roomId={room.id} onDenied={vi.fn()} />);
  const input = screen.getByRole('checkbox');
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.click(input);
  await screen.findByText('Не удалось сохранить правило, попробуйте снова');
  expect(input).toBeChecked();
  expect(input).toBeEnabled();
  fireEvent.click(input);
  await screen.findByText('Правило сохранено');
  expect(input).not.toBeChecked();
});
