import {validTimeZone} from './time';
export interface Room {
  // Room ID
  id: string;
  // Room name shown to the user
  name: string;
  // Room creation time in UTC
  createdAt: string;
  // One IANA zone for the whole room, unset until first admin entry
  timeZone?: string | null;
  // Room version used for updates
  revision: string;
}

export const roomIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const secretPattern = /^[0-9a-f]{64}$/;

// Check room data before showing it
export function isRoom(value: unknown): value is Room {
  // A room reply must be an object
  if (typeof value !== 'object' || value === null) return false;
  const room = value as Partial<Room>;
  return (
    typeof room.id === 'string' &&
    roomIdPattern.test(room.id) &&
    typeof room.name === 'string' &&
    typeof room.createdAt === 'string' &&
    Number.isFinite(Date.parse(room.createdAt)) &&
    (room.timeZone === undefined ||
      room.timeZone === null ||
      validTimeZone(room.timeZone)) &&
    typeof room.revision === 'string' &&
    /^\d+$/.test(room.revision)
  );
}

// Check the name length and reject null bytes
export function validName(value: unknown): value is string {
  // Count whole Unicode characters
  return (
    typeof value === 'string' &&
    Array.from(value).length <= 200 &&
    !value.includes('\0')
  );
}

// Check a room link before opening it
export function roomDestination(value: string, origin: string): string | null {
  try {
    const url = new URL(value.trim(), origin);
    // Do not send link keys to another site
    if (url.origin !== origin || url.username || url.password) return null;
    // Reject home, API and asset URLs
    if (url.pathname === '/' || /^\/(api|_next)(\/|$)/.test(url.pathname))
      return null;
    // Keep admin keys out of query strings
    if (url.searchParams.has('admin')) return null;
    // Check known room paths before opening them
    if (url.pathname.startsWith('/rooms/')) {
      const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
      if (!match || !roomIdPattern.test(match[1])) return null;
    }
    // Admin links need a valid room ID and key
    if (url.hash.startsWith('#admin=')) {
      const match = /^\/rooms\/([^/]+)\/?$/.exec(url.pathname);
      if (
        !match ||
        !roomIdPattern.test(match[1]) ||
        !/^#admin=[0-9a-f]{64}$/.test(url.hash)
      )
        return null;
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
