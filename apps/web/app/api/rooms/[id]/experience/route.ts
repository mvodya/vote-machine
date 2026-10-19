import {experienceProxy} from '../../../../../lib/experience-proxy';
export const dynamic = 'force-dynamic';
// Read the room palette and safe events
export async function GET(
  request: Request,
  {params}: {params: Promise<{id: string}>},
) {
  return experienceProxy(request, (await params).id, true);
}
// Only an admin may change the room palette
export const PATCH = GET;
