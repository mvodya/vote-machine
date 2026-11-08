import {registrationAdminProxy} from '../../../../../../../lib/registration-proxy';
export const dynamic = 'force-dynamic';
// Return only this room's registered people
export async function GET(
  request: Request,
  context: {params: Promise<{id: string; linkId: string}>},
) {
  const {id, linkId} = await context.params;
  return registrationAdminProxy(request, id, linkId);
}
