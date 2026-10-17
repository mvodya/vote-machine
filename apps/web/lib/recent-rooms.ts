import {NextResponse} from 'next/server';
import {roomIdPattern, secretPattern, type Room} from './rooms';

export interface SavedRoom {
  // Room ID
  id: string;
  // Room name shown to the user
  name: string;
  // Admin session key for this browser
  token: string;
  // Last visit time in milliseconds
  usedAt: number;
}
// Prefix for saved room cookies
const prefix = 'vm_room_';
// Build a separate cookie name for each room
export function roomCookieName(id: string) {
  return `${prefix}${id}`;
}
// Encode cookie data as URL-safe text
export function roomCookieValue(room: SavedRoom) {
  return Buffer.from(JSON.stringify(room)).toString('base64url');
}

// Read saved rooms from browser cookies
export function savedRooms(request: Request): SavedRoom[] {
  // Keep one entry per room
  const found = new Map<string, SavedRoom>();
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    // Ignore cookies from other features
    if (!name?.startsWith(prefix)) continue;
    try {
      // Cookie text may have been changed or damaged
      const item = JSON.parse(
        Buffer.from(value.join('='), 'base64url').toString('utf8'),
      ) as SavedRoom;
      // Only use entries with valid fields
      if (
        !roomIdPattern.test(item.id) ||
        roomCookieName(item.id) !== name ||
        !secretPattern.test(item.token) ||
        typeof item.name !== 'string' ||
        Array.from(item.name).length > 200 ||
        !Number.isSafeInteger(item.usedAt) ||
        item.usedAt < 0
      )
        continue;
      found.set(item.id, item);
    } catch {
      /* Ignore damaged cookie values */
    }
  }
  // Put the last opened room first
  return [...found.values()].sort(
    (a, b) => b.usedAt - a.usedAt || a.id.localeCompare(b.id),
  );
}

// Keep tokens private and allow long browser storage
const options = (request: Request) => ({
  // Hide tokens from page scripts
  httpOnly: true,
  // Send this cookie only within this site
  sameSite: 'strict' as const,
  // Require HTTPS on secure sites
  secure:
    new URL(request.url).protocol === 'https:' ||
    request.headers.get('x-forwarded-proto') === 'https',
  // Home and room routes need this cookie
  path: '/',
  // Browsers may shorten this storage time
  expires: new Date('9999-12-31T23:59:59Z'),
});
// Remove the browser entry without deleting the room
export function forgetRoom(
  response: NextResponse,
  request: Request,
  id: string,
) {
  // Expire the cookie without deleting database data
  response.cookies.set(roomCookieName(id), '', {
    ...options(request),
    expires: new Date(0),
  });
}

// Save the room name, token and last visit
export function rememberRoom(
  response: NextResponse,
  request: Request,
  room: Room,
  token: string,
) {
  const current: SavedRoom = {
    id: room.id,
    name: room.name,
    token,
    usedAt: Date.now(),
  };
  const previous = savedRooms(request).filter((item) => item.id !== room.id);
  // Count names, values and cookie separators
  let size =
    roomCookieName(current.id).length + roomCookieValue(current).length + 2;
  for (const item of previous) {
    size += roomCookieName(item.id).length + roomCookieValue(item).length + 2;
    // Leave space for other request headers
    if (size > 6000) forgetRoom(response, request, item.id);
  }
  response.cookies.set(
    roomCookieName(room.id),
    roomCookieValue(current),
    options(request),
  );
}

// Check that a write came from this site
export function sameOrigin(request: Request) {
  try {
    const origin = new URL(request.headers.get('origin') ?? '');
    // Use the public scheme when behind a proxy
    const scheme =
      request.headers.get('x-forwarded-proto') ??
      new URL(request.url).protocol.slice(0, -1);
    return (
      origin.host ===
        (request.headers.get('host') ?? new URL(request.url).host) &&
      origin.protocol === `${scheme}:` &&
      request.headers.get('sec-fetch-site') !== 'cross-site'
    );
  } catch {
    return false;
  }
}
