import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import CreateRoom from '../app/create-room';

const {push} = vi.hoisted(() => ({push: vi.fn()}));
vi.mock('next/navigation', () => ({useRouter: () => ({push})}));

describe('Room creation', () => {
  it('opens the secret fragment returned by the API', async () => {
    const id = 'a96c3a49-0198-4545-8dce-44b70c86494d';
    const token = 'a'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          room: {
            id,
            name: 'Test',
            createdAt: '2026-10-25T00:00:00Z',
            revision: '0',
          },
          adminToken: token,
        }),
      ),
    );
    render(<CreateRoom />);
    fireEvent.change(screen.getByLabelText('Название комнаты'), {
      target: {value: 'Test'},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Создать комнату'}));
    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/rooms/${id}#admin=${token}`),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/rooms',
      expect.objectContaining({body: '{"name":"Test"}'}),
    );
  });

  it('shows a retryable error without showing server details', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({error: 'secret'}, {status: 503})),
    );
    render(<CreateRoom />);
    fireEvent.click(screen.getByRole('button', {name: 'Создать комнату'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Не удалось создать комнату',
    );
    expect(screen.getByRole('button')).toBeEnabled();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
