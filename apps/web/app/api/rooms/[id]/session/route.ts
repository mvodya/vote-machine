import {roomProxy} from '../../../../../lib/room-proxy';

export const dynamic = 'force-dynamic';

// Exchange an admin link for a browser session
export async function POST(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  return roomProxy(request, 'exchange', (await context.params).id);
}
