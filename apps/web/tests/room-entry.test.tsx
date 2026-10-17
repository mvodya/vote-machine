import {act, fireEvent, render, screen} from '@testing-library/react';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import RoomEntry from '../app/room-entry';
import {roomDestination} from '../lib/rooms';

const {push} = vi.hoisted(() => ({push: vi.fn()}));
vi.mock('next/navigation', () => ({useRouter: () => ({push})}));
const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const key = 'b'.repeat(64);
const path = `/rooms/${id}`;
beforeEach(() => {
  push.mockClear();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({rooms: []})));
});

describe('Saved room links', () => {
  it('opens a local link without changing or storing its key', () => {
    expect(
      roomDestination(
        ` https://vote.test${path}#admin=${key} `,
        'https://vote.test',
      ),
    ).toBe(`${path}#admin=${key}`);
    expect(roomDestination(path, 'https://vote.test')).toBe(path);
    expect(
      roomDestination('/vote/participant#key=abc', 'https://vote.test'),
    ).toBe('/vote/participant#key=abc');
  });

  it.each([
    `https://evil.test${path}#admin=${key}`,
    `https://user:secret@vote.test${path}`,
    `${path}?admin=${key}`,
    `${path}#admin=bad`,
    '/rooms/not-a-room',
    'javascript:alert(1)',
    '',
  ])('rejects invalid or external destinations', (value) => {
    expect(roomDestination(value, 'https://vote.test')).toBeNull();
  });

  it('switches from creation to opening a saved room', () => {
    render(<RoomEntry />);
    expect(screen.getByLabelText('Название комнаты')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: /^Войти$/}));
    expect(screen.queryByLabelText('Название комнаты')).not.toBeInTheDocument();
    const link = `${window.location.origin}${path}#admin=${key}`;
    fireEvent.change(screen.getByLabelText('Ссылка на комнату'), {
      target: {value: link},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Войти в комнату'}));
    expect(push).toHaveBeenCalledWith(`${path}#admin=${key}`);
  });

  it('keeps a bad link on the entry screen and shows a plain error', () => {
    render(<RoomEntry />);
    fireEvent.click(screen.getByRole('button', {name: /^Войти$/}));
    fireEvent.change(screen.getByLabelText('Ссылка на комнату'), {
      target: {value: 'https://evil.test/private'},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Войти в комнату'}));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Вставьте корректную ссылку на комнату с этого сайта',
    );
    expect(screen.getByLabelText('Ссылка на комнату')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

it('does not open a late create response after switching to room entry', async () => {
  let finish!: (response: Response) => void;
  const fetchMock = vi.fn().mockImplementation((url) =>
    url === '/api/recent-rooms'
      ? Promise.resolve(Response.json({rooms: []}))
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(<RoomEntry />);
  fireEvent.click(screen.getByRole('button', {name: 'Создать комнату'}));
  fireEvent.click(screen.getByRole('button', {name: /^Войти$/}));
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  await act(async () => {
    finish(
      Response.json({
        room: {
          id,
          name: 'Late room',
          createdAt: '2026-10-25T00:00:00Z',
          revision: '0',
        },
        adminToken: key,
      }),
    );
  });
  expect(push).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Ссылка на комнату')).toBeVisible();
});
