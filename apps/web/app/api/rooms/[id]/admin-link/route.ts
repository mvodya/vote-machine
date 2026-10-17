import {roomProxy} from '../../../../../lib/room-proxy';
export const dynamic = 'force-dynamic';
// Read the admin link for an allowed session
export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return roomProxy(request, 'link', (await context.params).id);
}
