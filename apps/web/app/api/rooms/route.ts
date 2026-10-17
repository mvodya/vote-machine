import {roomProxy} from '../../../lib/room-proxy';

export const dynamic = 'force-dynamic';

// Create a room through the API
export async function POST(request: Request) {
  return roomProxy(request, 'create');
}
