import {timeZoneProxy} from '../../../../../lib/time-zone-proxy';
export const dynamic = 'force-dynamic';
// Save the shared zone with room-scoped access
export async function PATCH(
  request: Request,
  context: {params: Promise<{id: string}>},
) {
  const {id} = await context.params;
  return timeZoneProxy(request, id);
}
