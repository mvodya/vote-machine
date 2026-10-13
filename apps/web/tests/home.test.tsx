import {fireEvent, render, screen} from '@testing-library/react';
import {describe, expect, it, vi} from 'vitest';
import Home from '../app/page';

describe('Connection screen', () => {
  it('shows loading and then real response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          message: 'Message from test server',
          database: 'connected',
        }),
      ),
    );
    render(<Home />);
    expect(screen.getByText('Проверяем соединение…')).toBeInTheDocument();
    expect(
      await screen.findByText('Message from test server'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('can retry after failure', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce(
        Response.json({message: 'Hello world', database: 'connected'}),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<Home />);
    expect(
      await screen.findByText('Не удалось получить ответ'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Hello world')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    () => Response.json({error: 'Unavailable'}, {status: 503}),
    () => Response.json({message: 'Wrong shape'}),
  ])('does not show success for a bad response', async (response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()));
    render(<Home />);
    expect(
      await screen.findByText('Не удалось получить ответ'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Соединение работает')).not.toBeInTheDocument();
  });
});
