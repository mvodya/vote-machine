import {NextResponse} from 'next/server';
import {savedRooms} from '../../../lib/recent-rooms';
export const dynamic = 'force-dynamic';
// List cached room names without their tokens
export async function GET(request: Request) {
  return NextResponse.json(
    {rooms: savedRooms(request).map(({id, name}) => ({id, name}))},
    {headers: {'Cache-Control': 'no-store'}},
  );
}
