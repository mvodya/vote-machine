import {createHash} from 'node:crypto';
import {savedRooms} from '../../../lib/recent-rooms';
import {participantToken} from '../../../lib/ballot-proxy';
import {roomIdPattern} from '../../../lib/rooms';

export const dynamic = 'force-dynamic';
const headers = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
};
// Report only public process labels and a separate one-way session tag
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const id = params.get('id') ?? '';
  const scope = params.get('scope');
  const token = roomIdPattern.test(id)
    ? scope === 'rooms'
      ? savedRooms(request).find((room) => room.id === id)?.token
      : scope === 'vote'
        ? participantToken(request, id)
        : null
    : null;
  try {
    const response = await fetch(
      new URL('/health/ready', process.env.API_ORIGIN ?? 'http://api:8080'),
      {
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      },
    );
    const body = await response.json();
    if (
      !response.ok ||
      typeof body.apiId !== 'string' ||
      !/^[a-f0-9]{12}$/.test(body.apiId) ||
      typeof body.commit !== 'string' ||
      !/^(dev|[a-f0-9]{7,40})$/i.test(body.commit) ||
      !Number.isSafeInteger(body.serverTime)
    )
      throw new Error('Unavailable');
    return Response.json(
      {
        apiId: body.apiId,
        commit: body.commit,
        serverTime: body.serverTime,
        clientId: token
          ? createHash('sha256')
              .update(`vote-machine:diagnostic:${token}`)
              .digest('hex')
              .slice(0, 16)
          : null,
      },
      {headers},
    );
  } catch {
    return Response.json(
      {error: 'Connection unavailable'},
      {status: 503, headers},
    );
  }
}
