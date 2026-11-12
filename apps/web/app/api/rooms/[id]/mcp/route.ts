import {savedRooms, sameOrigin} from '../../../../../lib/recent-rooms';
import {roomIdPattern} from '../../../../../lib/rooms';
import {mcpBackend, mcpHeaders} from '../../../../../lib/server/mcp-backend';

export const dynamic = 'force-dynamic';

// Keep issuance and rotation behind the room admin cookie
async function manageToken(request: Request, room: string) {
  if (!sameOrigin(request))
    return Response.json(
      {error: 'origin_denied'},
      {status: 403, headers: mcpHeaders},
    );
  const session = roomIdPattern.test(room)
    ? savedRooms(request).find((entry) => entry.id === room)?.token
    : undefined;
  if (!session)
    return Response.json(
      {error: 'access_denied'},
      {status: 401, headers: mcpHeaders},
    );
  try {
    const response = await mcpBackend(
      'token',
      room,
      session,
      request.method === 'PUT' ? 'rotate' : 'ensure',
    );
    return Response.json(await response.json(), {
      status: response.status,
      headers: mcpHeaders,
    });
  } catch {
    return Response.json(
      {error: 'unavailable'},
      {status: 503, headers: mcpHeaders},
    );
  }
}

// Return the current token or issue the first one
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return manageToken(request, (await context.params).id);
}

// Replace the current token in one database transaction
export async function PUT(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return manageToken(request, (await context.params).id);
}
