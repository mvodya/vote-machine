import {roomProxy} from '../../../../lib/room-proxy';

type Context = {params: Promise<{id: string}>};
export const dynamic = 'force-dynamic';

// Read a room using its saved session
export async function GET(request: Request, context: Context) {
  return roomProxy(request, 'read', (await context.params).id);
}

// Rename a room using its saved session
export async function PATCH(request: Request, context: Context) {
  return roomProxy(request, 'rename', (await context.params).id);
}
