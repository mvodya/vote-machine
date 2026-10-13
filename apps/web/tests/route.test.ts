import {describe, expect, it, vi} from 'vitest';
import {GET} from '../app/api/hello/route';

describe('Hello proxy', () => {
  it('forwards safe fields and disables cache', async () => {
    vi.stubEnv('API_ORIGIN', 'http://test-api:8080');
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        message: 'DB reply',
        database: 'connected',
        internal: 'private',
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET();
    expect(await response.json()).toEqual({
      message: 'DB reply',
      database: 'connected',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://test-api:8080/api/hello',
    );
  });

  it('hides upstream errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json({secret: 'database details'}, {status: 503}),
        ),
    );
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error: 'Service is unavailable'});
  });

  it('rejects invalid success body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({message: 12})),
    );
    expect((await GET()).status).toBe(502);
  });

  it('handles network errors and timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Secret host')));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({error: 'Service is unavailable'});
  });
});
