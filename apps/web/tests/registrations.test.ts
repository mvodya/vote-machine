import {expect, it, vi} from 'vitest';
import {registrationStatus, registrationsCsv} from '../lib/registrations';
import {
  registrationProxy,
  registrationAdminProxy,
} from '../lib/registration-proxy';
import {votingCookie} from '../lib/link-proxy';
const group = 'a96c3a49-0198-4545-8dce-44b70c86494d';
const member = 'a96c3a49-0198-4545-8dce-44b70c86494e';
const child = 'a96c3a49-0198-4545-8dce-44b70c86494f';
const token = 'a'.repeat(64);
const person = {
  id: member,
  name: 'Alice',
  state: 'approved' as const,
  blocked: false,
  revision: '1',
  callSequence: '0',
  calledAt: null,
};
const status = {
  groupName: 'Students',
  moderation: true,
  closed: false,
  accent: 'green',
  serverTime: '2026-11-09T00:00:00Z',
  member: person,
  votingId: child,
  sessionToken: token,
};
// Build a lobby request using only the group's cookie
function request(method = 'GET', origin = 'https://vote.test') {
  return new Request(`https://vote.test/api/vote/${group}/registration`, {
    method,
    headers: {
      Cookie: `${votingCookie(group)}=${token}`,
      Origin: origin,
      'Content-Type': 'application/json',
    },
    body:
      method === 'GET'
        ? undefined
        : JSON.stringify({
            name: 'Alice',
            state: 'approved',
            sessionToken: 'forged',
          }),
  });
}
it('keeps private voting credentials in a scoped HttpOnly cookie', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(status)));
  const response = await registrationProxy(request(), group);
  expect(response.status).toBe(200);
  const data = await response.json();
  expect(data.sessionToken).toBeUndefined();
  expect(data.votingId).toBe(child);
  const cookie = response.headers.get('set-cookie')!;
  expect(cookie).toContain(`Path=/api/vote/${child}`);
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
});
it('never grants a pending or blocked member a private cookie', async () => {
  for (const change of [{state: 'pending'}, {blocked: true}]) {
    const data = {...status, member: {...person, ...change}};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(data)));
    const response = await registrationProxy(request(), group);
    expect(response.status).toBe(200);
    expect(response.headers.has('set-cookie')).toBe(false);
    expect((await response.json()).votingId).toBeUndefined();
  }
});
it('rejects cross-origin registration and forwards only the entered name', async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json(status));
  vi.stubGlobal('fetch', fetcher);
  expect(
    (await registrationProxy(request('POST', 'https://evil.test'), group))
      .status,
  ).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
  expect((await registrationProxy(request('POST'), group)).status).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({name: 'Alice'});
  expect((await registrationAdminProxy(request(), group, group)).status).toBe(
    401,
  );
});
it('exports group and member IDs while escaping CSV names', () => {
  const csv = registrationsCsv(
    [
      {...person, name: ' =SUM(1,2)'},
      {...person, name: 'A "quote"', blocked: true},
    ],
    (value) => value,
    '=Group',
  );
  expect(csv).toContain('"\' =SUM(1,2)"');
  expect(csv).toContain('"A ""quote""","\'=Group","Заблокирован"');
  expect(csv).toContain(member);
  expect(csv).toContain('"ID участника","Имя","Группа","Статус"');
  expect(
    registrationStatus({...status, member: {...person, revision: '-1'}}),
  ).toBeNull();
});

it('checks admin rename origin and forwards only a valid name with its revision', async () => {
  const {roomCookieValue} = await import('../lib/recent-rooms');
  const cookie = `vm_room_${group}=${roomCookieValue({id: group, name: 'Room', token, usedAt: 1})}`;
  const rename = (name: string, origin = 'https://vote.test') =>
    new Request(
      `https://vote.test/api/rooms/${group}/links/${group}/members/${member}`,
      {
        method: 'PATCH',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'rename',
          name,
          revision: '1',
          blocked: false,
        }),
      },
    );
  const fetcher = vi
    .fn()
    .mockImplementation(async () => Response.json({ok: true}));
  vi.stubGlobal('fetch', fetcher);
  expect(
    (
      await registrationAdminProxy(
        rename('Bob', 'https://other.test'),
        group,
        group,
        member,
      )
    ).status,
  ).toBe(403);
  expect(
    (await registrationAdminProxy(rename('  '), group, group, member)).status,
  ).toBe(400);
  expect(fetcher).not.toHaveBeenCalled();
  expect(
    (await registrationAdminProxy(rename('Bob'), group, group, member)).status,
  ).toBe(200);
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    action: 'rename',
    name: 'Bob',
    revision: '1',
  });
});

it('registration CSV keeps pending and blocked people but omits rejected attempts', () => {
  const csv = registrationsCsv(
    [
      {...person, name: 'Pending', state: 'pending'},
      {...person, name: 'Blocked', blocked: true},
      {...person, name: 'Rejected', state: 'rejected'},
    ],
    (value) => value,
    'Students',
  );
  expect(csv).toContain('"Pending","Students","Ожидает подтверждения"');
  expect(csv).toContain('"Blocked","Students","Заблокирован"');
  expect(csv).not.toContain('Rejected');
  expect(csv).not.toContain('callSequence');
  expect(csv).not.toContain(token);
});
